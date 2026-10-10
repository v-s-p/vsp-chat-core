import { createServer } from 'node:http';

import { ChatCoreError } from '../../core/chat-event.js';
import {
  REDIRECT_HOST, REDIRECT_PATH, DEFAULT_REDIRECT_PORT, REFRESH_SKEW_MS
} from './constants.js';
import { createPkcePair, randomToken } from './pkce.js';
import { buildAuthorizeUrl, exchangeCode, refreshTokens, revokeToken, hasPlanScope } from './oauth-client.js';
import { validateIdToken } from './id-token.js';
import { CredentialStore } from './credential-store.js';

const LOGIN_TIMEOUT_MS = 5 * 60_000;

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;text-align:center">
<h2>${title}</h2><p>${text}</p></body>`;

// Owns everything about the ChatGPT plan credential lifecycle: sign-in via a
// loopback redirect, ID token validation, storage, refresh and sign-out.
// Adapters only ever call getAccessToken(); authentication stays out of the
// ChatProvider contract (docs/DESIGN.md §3).
export class PlanSession {
  #store;
  #fetch;
  #now;
  #jwks;
  #redirectPort;
  #pendingLogin = null;
  #refreshInFlight = null;

  constructor({
    store = new CredentialStore(),
    fetchImpl = fetch,
    now = Date.now,
    jwks,
    redirectPort = DEFAULT_REDIRECT_PORT
  } = {}) {
    this.#store = store;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#jwks = jwks;
    this.#redirectPort = redirectPort;
  }

  async status() {
    const creds = await this.#store.loadCredentials();
    if (!creds?.access_token) return { signedIn: false, loginPending: Boolean(this.#pendingLogin) };
    return {
      signedIn: true,
      email: creds.email,
      planScope: hasPlanScope(creds.scopes),
      expiresAt: creds.expires_at,
      loginPending: Boolean(this.#pendingLogin)
    };
  }

  // Starts a loopback listener, then returns the URL the user must open.
  // `completion` resolves with the new status once the browser redirects back,
  // or rejects on denial / state mismatch / timeout.
  async startLogin() {
    if (this.#pendingLogin) this.#pendingLogin.abort('superseded by a new sign-in attempt');

    const client = await this.#store.loadClient();
    const hostId = await this.#store.ensureHostId();
    const previous = await this.#store.loadCredentials();
    const pkce = createPkcePair();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const issuedClientId = client?.client_id;

    // Only the port may vary between sign-ins, so a busy default (e.g. another
    // tool's own sign-in on 1455) falls through to the next few ports.
    const server = createServer();
    const candidates = this.#redirectPort === 0
      ? [0]
      : Array.from({ length: 6 }, (_, i) => this.#redirectPort + i);
    let lastError;
    for (const candidate of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => { server.off('listening', onListening); reject(err); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(candidate, REDIRECT_HOST);
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      throw new ChatCoreError({
        code: 'plan_login_port_busy',
        message: `no free port on ${REDIRECT_HOST} for the sign-in redirect (${lastError.code || 'error'})`
      });
    }
    const port = server.address().port;
    const redirectUri = `http://${REDIRECT_HOST}:${port}${REDIRECT_PATH}`;

    const authorizeUrl = buildAuthorizeUrl({
      clientId: issuedClientId,
      hostId,
      redirectUri,
      state,
      nonce,
      codeChallenge: pkce.challenge,
      idTokenHint: issuedClientId ? previous?.id_token : undefined,
      loginHint: issuedClientId ? previous?.email : undefined
    });

    let settle;
    const completion = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    completion.catch(() => {}); // callers may ignore it; never an unhandled rejection

    const finish = (err, value) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (this.#pendingLogin?.state === state) this.#pendingLogin = null;
      if (err) settle.reject(err); else settle.resolve(value);
    };
    const timer = setTimeout(() => finish(new ChatCoreError({ code: 'plan_login_timeout', message: 'sign-in was not completed in time' })), LOGIN_TIMEOUT_MS);
    timer.unref?.();

    server.on('request', async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (req.method !== 'GET' || url.pathname !== REDIRECT_PATH) {
        res.writeHead(404).end();
        return;
      }
      const q = url.searchParams;
      // State first: anything without our state is not our redirect and must
      // not be able to end (or influence) the pending attempt.
      if (q.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Invalid request', 'This redirect does not belong to the current sign-in attempt.'));
        return;
      }
      if (q.get('error')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in cancelled', 'You can close this tab.'));
        finish(new ChatCoreError({ code: 'plan_login_denied', message: `sign-in was not completed (${q.get('error')})` }));
        return;
      }
      try {
        const result = await this.#completeLogin({
          code: q.get('code'),
          callbackClientId: q.get('client_id') || undefined,
          issuedClientId,
          redirectUri,
          codeVerifier: pkce.verifier,
          nonce,
          previous
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Signed in', 'VSP Chat Core is connected to your ChatGPT plan. You can close this tab.'));
        finish(null, result);
      } catch (err) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'See the error message in the chat window.'));
        finish(err instanceof ChatCoreError ? err : new ChatCoreError({ code: 'plan_login_failed', message: err?.message || 'sign-in failed' }));
      }
    });

    this.#pendingLogin = {
      state,
      abort: (reason) => finish(new ChatCoreError({ code: 'plan_login_cancelled', message: reason }))
    };

    return { authorizeUrl, redirectUri, completion };
  }

  async #completeLogin({ code, callbackClientId, issuedClientId, redirectUri, codeVerifier, nonce, previous }) {
    if (!code) throw new ChatCoreError({ code: 'plan_login_failed', message: 'redirect carried no authorization code' });

    let clientId;
    if (!issuedClientId) {
      // First registration: the issued id arrives on the callback. Without
      // it registration is incomplete and nothing is stored.
      if (!callbackClientId) throw new ChatCoreError({ code: 'plan_registration_incomplete', message: 'sign-in returned no issued client id' });
      clientId = callbackClientId;
    } else {
      if (callbackClientId && callbackClientId !== issuedClientId) {
        throw new ChatCoreError({ code: 'plan_client_mismatch', message: 'redirect carried a different client id than the registered one' });
      }
      clientId = issuedClientId;
    }

    const tokens = await exchangeCode({ clientId, code, codeVerifier, redirectUri, fetchImpl: this.#fetch, now: this.#now });
    const identity = await validateIdToken(tokens.id_token, {
      clientId, nonce, jwks: this.#jwks, fetchImpl: this.#fetch, now: this.#now
    });

    // Persist the issued client id even if a later check fails: the
    // registration itself succeeded and must be reused next time.
    if (!issuedClientId) await this.#store.saveClientId(clientId);

    if (previous?.subject && previous.subject !== identity.subject) {
      throw new ChatCoreError({ code: 'plan_account_mismatch', message: 'signed in with a different ChatGPT account; sign out first to switch accounts' });
    }

    if (!hasPlanScope(tokens.scopes)) {
      await revokeToken({ clientId, refreshToken: tokens.refresh_token, fetchImpl: this.#fetch });
      throw new ChatCoreError({ code: 'plan_scope_declined', message: 'ChatGPT plan usage permission was not granted on the consent screen' });
    }

    await this.#store.saveCredentials({
      email: identity.email,
      issuer: identity.issuer,
      subject: identity.subject,
      client_id: clientId,
      ...tokens
    });
    return this.status();
  }

  // Returns a valid access token, refreshing first if it is about to expire.
  // Concurrent callers share one refresh: refresh tokens rotate, so two
  // parallel refreshes would invalidate each other (refresh_token_reused).
  async getAccessToken() {
    const creds = await this.#store.loadCredentials();
    if (!creds?.access_token) {
      throw new ChatCoreError({ code: 'plan_not_signed_in', message: 'not signed in with ChatGPT' });
    }
    const now = this.#now();
    if (creds.expires_at - REFRESH_SKEW_MS > now) return creds.access_token;
    // Respect the server's earliest refresh time while the token is still valid.
    if (creds.earliest_refresh_at && now < creds.earliest_refresh_at && creds.expires_at > now) {
      return creds.access_token;
    }

    if (!this.#refreshInFlight) {
      this.#refreshInFlight = this.#refresh(creds).finally(() => { this.#refreshInFlight = null; });
    }
    return this.#refreshInFlight;
  }

  async #refresh(creds) {
    let tokens;
    try {
      tokens = await refreshTokens({ clientId: creds.client_id, refreshToken: creds.refresh_token, fetchImpl: this.#fetch, now: this.#now });
    } catch (err) {
      if (err?.code === 'plan_reauth_required') await this.#store.clearCredentials();
      throw err;
    }

    let identity = { subject: creds.subject, email: creds.email, issuer: creds.issuer };
    if (tokens.id_token) {
      identity = await validateIdToken(tokens.id_token, { clientId: creds.client_id, jwks: this.#jwks, fetchImpl: this.#fetch, now: this.#now });
      if (identity.subject !== creds.subject) {
        await this.#store.clearCredentials();
        throw new ChatCoreError({ code: 'plan_account_mismatch', message: 'refreshed token belongs to a different account' });
      }
    }

    // Access token, expiry, scopes and the rotated refresh token are replaced together.
    await this.#store.saveCredentials({
      ...creds,
      ...tokens,
      id_token: tokens.id_token || creds.id_token,
      email: identity.email ?? creds.email
    });
    return tokens.access_token;
  }

  async logout() {
    this.#pendingLogin?.abort('signed out');
    const creds = await this.#store.loadCredentials();
    if (creds?.refresh_token) {
      await revokeToken({ clientId: creds.client_id, refreshToken: creds.refresh_token, fetchImpl: this.#fetch });
    }
    await this.#store.clearCredentials();
    return this.status();
  }
}
