import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildAuthorizeUrl, refreshTokens, exchangeCode, hasPlanScope } from '../src/access/chatgpt-plan/oauth-client.js';
import { createPkcePair } from '../src/access/chatgpt-plan/pkce.js';
import { validateIdToken } from '../src/access/chatgpt-plan/id-token.js';
import { defaultCredentialsDir } from '../src/access/chatgpt-plan/credential-store.js';
import { JWKS, makeIdToken, idClaims, otherKey, tempStore, jsonResponse, formOf } from './helpers/plan-fakes.js';

const base = { hostId: 'host-1', redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's', nonce: 'n', codeChallenge: 'c' };

test('first sign-in registers dynamically and sends agent_name_hint, never hints', () => {
  const q = new URL(buildAuthorizeUrl({ ...base, idTokenHint: 'x', loginHint: 'y' })).searchParams;
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  assert.equal(q.get('agent_name_hint'), 'VSP Chat Core');
  assert.equal(q.get('id_token_hint'), null);
  assert.equal(q.get('login_hint'), null);
  assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(q.get('resource'), 'https://api.openai.com/v1');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('ext_agent_host_id'), 'host-1');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
});

test('re-authorization reuses the issued client id and drops agent_name_hint', () => {
  const q = new URL(buildAuthorizeUrl({ ...base, clientId: 'oaiapp_test', idTokenHint: 'idt', loginHint: 'a@b.c' })).searchParams;
  assert.equal(q.get('client_id'), 'oaiapp_test');
  assert.equal(q.get('agent_name_hint'), null);
  assert.equal(q.get('id_token_hint'), 'idt');
  assert.equal(q.get('login_hint'), 'a@b.c');
});

test('PKCE challenge is unpadded base64url SHA-256 of a 43-char verifier', () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(verifier.length, 43);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(!challenge.includes('='));
});

test('ID token: valid token yields identity', async () => {
  const idt = makeIdToken(idClaims({ nonce: 'n1' }));
  const id = await validateIdToken(idt, { clientId: 'oaiapp_test', nonce: 'n1', jwks: JWKS });
  assert.deepEqual(id, { subject: 'user-123', email: 'owner@example.com', issuer: 'https://auth.openai.com' });
});

test('ID token: forged signature, wrong issuer/audience/nonce, expiry and alg are all rejected', async () => {
  const opts = { clientId: 'oaiapp_test', nonce: 'n1', jwks: JWKS };
  const bad = [
    makeIdToken(idClaims({ nonce: 'n1' }), { key: otherKey() }),
    makeIdToken(idClaims({ nonce: 'n1', iss: 'https://evil.example' })),
    makeIdToken(idClaims({ nonce: 'n1', aud: 'someone-else' })),
    makeIdToken(idClaims({ nonce: 'other' })),
    makeIdToken(idClaims({ nonce: 'n1', exp: Math.floor(Date.now() / 1000) - 3600 })),
    makeIdToken(idClaims({ nonce: 'n1' }), { kid: 'unknown' }),
    makeIdToken(idClaims({ nonce: 'n1' }), { alg: 'HS256' }),
    'not.a.jwt.at-all',
    undefined
  ];
  for (const [i, t] of bad.entries()) {
    await assert.rejects(validateIdToken(t, opts), { code: 'plan_id_token_invalid' }, `case ${i}`);
  }
});

test('code exchange posts the PKCE verifier, redirect uri and resource; scopes parsed', async () => {
  let form;
  const tokens = await exchangeCode({
    clientId: 'oaiapp_test', code: 'c1', codeVerifier: 'v1', redirectUri: base.redirectUri,
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
      form = formOf(init);
      return jsonResponse(200, { access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' });
    }
  });
  assert.deepEqual(form, { grant_type: 'authorization_code', client_id: 'oaiapp_test', code: 'c1', code_verifier: 'v1', redirect_uri: base.redirectUri, resource: 'https://api.openai.com/v1' });
  assert.equal(tokens.expires_at, 1_000 + 3_600_000);
  assert.ok(hasPlanScope(tokens.scopes));
});

test('refresh: terminal OAuth errors require re-auth; 5xx is retryable; invalid_client is distinct', async () => {
  for (const err of ['invalid_grant', 'refresh_token_reused', 'refresh_token_expired']) {
    await assert.rejects(refreshTokens({ clientId: 'c', refreshToken: 'r', fetchImpl: async () => jsonResponse(400, { error: err }) }), { code: 'plan_reauth_required' });
  }
  await assert.rejects(refreshTokens({ clientId: 'c', refreshToken: 'r', fetchImpl: async () => jsonResponse(401, { error: 'invalid_client' }) }), { code: 'plan_client_invalid' });
  await assert.rejects(refreshTokens({ clientId: 'c', refreshToken: 'r', fetchImpl: async () => jsonResponse(502, {}) }), { code: 'plan_refresh_failed', retryable: true });
});

test('credential store: owner-only atomic files, client.json survives sign-out', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const store = await tempStore();
  const hostId = await store.ensureHostId();
  assert.equal(await store.ensureHostId(), hostId, 'host id is stable');
  await store.saveClientId('oaiapp_test');
  await store.saveCredentials({ access_token: 'a', refresh_token: 'r' });

  const mode = (await stat(join(store.dir, 'credentials.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual((await readdir(store.dir)).sort(), ['client.json', 'credentials.json'], 'no temp files left behind');

  await store.clearCredentials();
  assert.equal(await store.loadCredentials(), null);
  assert.deepEqual(await store.loadClient(), { ext_agent_host_id: hostId, client_id: 'oaiapp_test' });
});

test('default credentials dir is per-user and outside the repo', () => {
  assert.equal(defaultCredentialsDir({ LOCALAPPDATA: 'C:\\Users\\K\\AppData\\Local' }, 'win32'),
    join('C:\\Users\\K\\AppData\\Local', 'vsp-chat-core', 'chatgpt-plan'));
  assert.equal(defaultCredentialsDir({ CHAT_CORE_CREDENTIALS_DIR: '/x' }, 'linux'), '/x');
});
