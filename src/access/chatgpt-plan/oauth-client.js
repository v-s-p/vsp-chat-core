import { ChatCoreError } from '../../core/chat-event.js';
import {
  AUTHORIZE_URL, TOKEN_URL, REVOKE_URL, RESOURCE, SCOPES, PLAN_SCOPE,
  DYNAMIC_CLIENT_ID, AGENT_NAME
} from './constants.js';

// Refresh failures after which the stored tokens are unusable and the user
// must sign in again (with the saved issued client id).
const REAUTH_ERRORS = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'
]);

export function parseScopes(scope) {
  if (Array.isArray(scope)) return scope;
  return typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
}

export function hasPlanScope(scopes) {
  return parseScopes(scopes).includes(PLAN_SCOPE);
}

// Builds the browser URL for both first-time registration and returning
// sign-in. Registration-only and reauthorization-only parameters are kept
// mutually exclusive here so callers can't mix them.
export function buildAuthorizeUrl({
  clientId, hostId, redirectUri, state, nonce, codeChallenge, idTokenHint, loginHint
}) {
  const registering = !clientId;
  const params = new URLSearchParams({
    client_id: registering ? DYNAMIC_CLIENT_ID : clientId,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });
  if (registering) {
    params.set('agent_name_hint', AGENT_NAME);
  } else {
    if (idTokenHint) params.set('id_token_hint', idTokenHint);
    if (loginHint) params.set('login_hint', loginHint);
  }
  // URLSearchParams form-encodes spaces as '+'; emit %20 instead so the
  // scope list survives strict RFC 3986 query parsing. A literal '+' in any
  // value is already escaped as %2B, so every '+' here is a space.
  return `${AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`;
}

async function readOAuthError(response) {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

async function postForm(url, fields, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString()
    });
  } catch (err) {
    throw new ChatCoreError({ code: 'network_error', message: `auth server unreachable: ${err?.message || 'network error'}`, retryable: true });
  }
  return response;
}

function tokenSetFrom(body, now) {
  if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string') {
    throw new ChatCoreError({ code: 'plan_token_response_invalid', message: 'token response is missing access or refresh token' });
  }
  const expiresIn = Number(body.expires_in) || 3600;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    id_token: body.id_token,
    token_type: body.token_type || 'Bearer',
    expires_at: now + expiresIn * 1000,
    earliest_refresh_at: body.earliest_refresh_at ? Date.parse(body.earliest_refresh_at) || undefined : undefined,
    scopes: parseScopes(body.scope)
  };
}

export async function exchangeCode({ clientId, code, codeVerifier, redirectUri, fetchImpl = fetch, now = Date.now }) {
  const response = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource: RESOURCE
  }, fetchImpl);

  if (!response.ok) {
    const oauthError = await readOAuthError(response);
    throw new ChatCoreError({
      code: oauthError === 'invalid_grant' ? 'plan_code_rejected' : 'plan_token_exchange_failed',
      message: `code exchange failed (HTTP ${response.status}${oauthError ? `, ${oauthError}` : ''})`,
      retryable: false
    });
  }
  return tokenSetFrom(await response.json(), now());
}

export async function refreshTokens({ clientId, refreshToken, fetchImpl = fetch, now = Date.now }) {
  const response = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken
  }, fetchImpl);

  if (!response.ok) {
    const oauthError = await readOAuthError(response);
    if (oauthError && REAUTH_ERRORS.has(oauthError)) {
      throw new ChatCoreError({ code: 'plan_reauth_required', message: `sign-in expired (${oauthError}); sign in with ChatGPT again` });
    }
    if (oauthError === 'invalid_client') {
      throw new ChatCoreError({ code: 'plan_client_invalid', message: 'the registered client is no longer valid' });
    }
    throw new ChatCoreError({
      code: 'plan_refresh_failed',
      message: `token refresh failed (HTTP ${response.status})`,
      retryable: response.status >= 500 || response.status === 429
    });
  }
  return tokenSetFrom(await response.json(), now());
}

// Best effort: a failed revoke must not keep the user "signed in" locally.
export async function revokeToken({ clientId, refreshToken, fetchImpl = fetch }) {
  try {
    const response = await postForm(REVOKE_URL, {
      client_id: clientId,
      token: refreshToken,
      token_type_hint: 'refresh_token'
    }, fetchImpl);
    return response.ok;
  } catch {
    return false;
  }
}
