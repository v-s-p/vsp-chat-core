import test from 'node:test';
import assert from 'node:assert/strict';

import { PlanSession } from '../src/access/chatgpt-plan/plan-session.js';
import { JWKS, makeIdToken, idClaims, tempStore, jsonResponse, routedFetch, formOf } from './helpers/plan-fakes.js';

const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const REVOKE = 'https://auth.openai.com/api/accounts/oauth/revoke';
const PLAN = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

// Plays the browser: follows the authorize URL's redirect_uri back to the
// session's loopback listener with whatever query the test wants.
async function browserRedirect(authorizeUrl, params) {
  const q = new URL(authorizeUrl).searchParams;
  const cb = new URL(q.get('redirect_uri'));
  for (const [k, v] of Object.entries(params(q))) cb.searchParams.set(k, v);
  const res = await fetch(cb);
  return { status: res.status, html: await res.text() };
}

function tokenFetch({ scope = PLAN, nonceFrom, sub = 'user-123', onToken } = {}) {
  let lastNonce;
  const f = routedFetch([
    [TOKEN, (url, init) => {
      onToken?.(formOf(init));
      return jsonResponse(200, {
        access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600, scope,
        id_token: makeIdToken(idClaims({ nonce: lastNonce, sub }))
      });
    }],
    [REVOKE, () => jsonResponse(200, {})]
  ]);
  f.setNonce = (n) => { lastNonce = n; };
  return f;
}

async function session(fetchImpl, store) {
  return new PlanSession({ store: store ?? await tempStore(), fetchImpl, jwks: JWKS, redirectPort: 0 });
}

test('first sign-in: loopback callback → code exchange → validated identity saved with plan scope', async () => {
  const store = await tempStore();
  let tokenForm;
  const f = tokenFetch({ onToken: (form) => { tokenForm = form; } });
  const s = await session(f, store);
  const { authorizeUrl, completion } = await s.startLogin();

  const q = new URL(authorizeUrl).searchParams;
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  f.setNonce(q.get('nonce'));

  const page = await browserRedirect(authorizeUrl, (aq) => ({ code: 'code-1', state: aq.get('state'), client_id: 'oaiapp_test', scope: PLAN }));
  assert.equal(page.status, 200);

  const status = await completion;
  assert.equal(status.signedIn, true);
  assert.equal(status.planScope, true);
  assert.equal(status.email, 'owner@example.com');
  assert.equal(tokenForm.client_id, 'oaiapp_test');
  assert.equal(tokenForm.redirect_uri, q.get('redirect_uri'));
  assert.equal((await store.loadClient()).client_id, 'oaiapp_test');
  assert.equal(await s.getAccessToken(), 'acc-1');
});

test('a redirect with the wrong state is refused and does not end the attempt', async () => {
  const f = tokenFetch();
  const s = await session(f);
  const { authorizeUrl } = await s.startLogin();
  const page = await browserRedirect(authorizeUrl, () => ({ code: 'evil', state: 'forged', client_id: 'oaiapp_x' }));
  assert.equal(page.status, 400);
  assert.equal(f.calls.length, 0, 'no code exchange for a forged state');
  assert.equal((await s.status()).loginPending, true);
  await s.logout();
});

test('user denies consent → plan_login_denied, nothing stored', async () => {
  const store = await tempStore();
  const s = await session(tokenFetch(), store);
  const { authorizeUrl, completion } = await s.startLogin();
  await browserRedirect(authorizeUrl, (q) => ({ error: 'access_denied', state: q.get('state') }));
  await assert.rejects(completion, { code: 'plan_login_denied' });
  assert.equal(await store.loadCredentials(), null);
});

test('plan permission declined on consent → tokens revoked, not saved, plan_scope_declined', async () => {
  const store = await tempStore();
  const f = tokenFetch({ scope: 'openid profile email offline_access resource.invoke' });
  const s = await session(f, store);
  const { authorizeUrl, completion } = await s.startLogin();
  f.setNonce(new URL(authorizeUrl).searchParams.get('nonce'));
  await browserRedirect(authorizeUrl, (q) => ({ code: 'c', state: q.get('state'), client_id: 'oaiapp_test' }));
  await assert.rejects(completion, { code: 'plan_scope_declined' });
  assert.equal(await store.loadCredentials(), null);
  assert.ok(f.calls.some((c) => c.url === REVOKE), 'refresh token revoked');
  assert.equal((await store.loadClient()).client_id, 'oaiapp_test', 'registration itself is kept for reuse');
});

test('first registration without an issued client_id on the callback is incomplete', async () => {
  const s = await session(tokenFetch());
  const { authorizeUrl, completion } = await s.startLogin();
  await browserRedirect(authorizeUrl, (q) => ({ code: 'c', state: q.get('state') }));
  await assert.rejects(completion, { code: 'plan_registration_incomplete' });
});

test('expired access token: concurrent callers share ONE refresh (rotating refresh tokens)', async () => {
  const store = await tempStore();
  await store.saveClientId('oaiapp_test');
  await store.saveCredentials({ client_id: 'oaiapp_test', subject: 'user-123', access_token: 'old', refresh_token: 'ref-old', expires_at: Date.now() - 1, scopes: PLAN.split(' ') });

  let refreshes = 0;
  const f = routedFetch([[TOKEN, async (url, init) => {
    refreshes++;
    assert.deepEqual(formOf(init), { grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'ref-old' });
    await new Promise((r) => setTimeout(r, 20));
    return jsonResponse(200, { access_token: 'new', refresh_token: 'ref-new', expires_in: 3600, scope: PLAN });
  }]]);
  const s = await session(f, store);

  const tokens = await Promise.all([s.getAccessToken(), s.getAccessToken(), s.getAccessToken()]);
  assert.deepEqual(tokens, ['new', 'new', 'new']);
  assert.equal(refreshes, 1);
  const saved = await store.loadCredentials();
  assert.equal(saved.refresh_token, 'ref-new', 'rotated refresh token replaced together with the access token');
  assert.equal(saved.subject, 'user-123');
});

test('terminal refresh error clears tokens so the UI asks for sign-in again', async () => {
  const store = await tempStore();
  await store.saveCredentials({ client_id: 'oaiapp_test', access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1, scopes: [] });
  const s = await session(routedFetch([[TOKEN, () => jsonResponse(400, { error: 'refresh_token_expired' })]]), store);
  await assert.rejects(s.getAccessToken(), { code: 'plan_reauth_required' });
  assert.equal((await s.status()).signedIn, false);
});

test('transient refresh failure keeps credentials', async () => {
  const store = await tempStore();
  await store.saveCredentials({ client_id: 'oaiapp_test', access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1, scopes: [] });
  const s = await session(routedFetch([[TOKEN, () => jsonResponse(503, {})]]), store);
  await assert.rejects(s.getAccessToken(), { code: 'plan_refresh_failed' });
  assert.equal((await s.status()).signedIn, true);
});

test('not signed in → plan_not_signed_in', async () => {
  const s = await session(routedFetch([]));
  await assert.rejects(s.getAccessToken(), { code: 'plan_not_signed_in' });
});

test('logout revokes the refresh token and clears credentials', async () => {
  const store = await tempStore();
  await store.saveCredentials({ client_id: 'oaiapp_test', access_token: 'a', refresh_token: 'r-9', expires_at: Date.now() + 3_600_000, scopes: [] });
  let revoked;
  const s = await session(routedFetch([[REVOKE, (url, init) => { revoked = formOf(init); return jsonResponse(200, {}); }]]), store);
  const status = await s.logout();
  assert.equal(status.signedIn, false);
  assert.deepEqual(revoked, { client_id: 'oaiapp_test', token: 'r-9', token_type_hint: 'refresh_token' });
});

test('busy default redirect port falls through to the next free one', async () => {
  const { createServer } = await import('node:net');
  const blocker = createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const s = new PlanSession({ store: await tempStore(), fetchImpl: routedFetch([]), jwks: JWKS, redirectPort: busy });
  try {
    const { authorizeUrl } = await s.startLogin();
    const port = Number(new URL(new URL(authorizeUrl).searchParams.get('redirect_uri')).port);
    assert.notEqual(port, busy);
    assert.ok(port > busy && port <= busy + 5);
  } finally {
    await s.logout();
    blocker.close();
  }
});
