import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CredentialStore } from '../../src/access/chatgpt-plan/credential-store.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const KID = 'test-kid';
export const JWKS = [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }];

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function makeIdToken(claims, { kid = KID, alg = 'RS256', key = privateKey } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export function otherKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

export function idClaims(overrides = {}) {
  return {
    iss: 'https://auth.openai.com',
    aud: 'oaiapp_test',
    sub: 'user-123',
    email: 'owner@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  };
}

export async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'chat-core-plan-'));
  return new CredentialStore(dir);
}

export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: null
  };
}

export function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
        controller.close();
      }
    })
  };
}

export const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

// Routes fetch calls by URL; records every call for assertions.
export function routedFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (String(url).startsWith(match)) return handler(String(url), init, calls);
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  fn.calls = calls;
  return fn;
}

export function formOf(init) {
  return Object.fromEntries(new URLSearchParams(init.body));
}
