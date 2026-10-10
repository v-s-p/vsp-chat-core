import { createPublicKey, verify } from 'node:crypto';

import { ChatCoreError } from '../../core/chat-event.js';
import { AUTH_ISSUER, JWKS_URL } from './constants.js';

const CLOCK_SKEW_SECONDS = 120;

function invalid(message) {
  return new ChatCoreError({ code: 'plan_id_token_invalid', message });
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw invalid('ID token is not a well-formed JWT');
  }
}

export function decodeJwt(token) {
  if (typeof token !== 'string') throw invalid('ID token missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('ID token is not a well-formed JWT');
  return {
    header: decodePart(parts[0]),
    payload: decodePart(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url')
  };
}

export async function fetchJwks(fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(JWKS_URL, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new ChatCoreError({ code: 'network_error', message: `could not fetch JWKS: ${err?.message || 'network error'}`, retryable: true });
  }
  if (!response.ok) {
    throw new ChatCoreError({ code: 'http_error', message: `JWKS endpoint responded with HTTP ${response.status}`, retryable: response.status >= 500 });
  }
  const body = await response.json();
  if (!Array.isArray(body?.keys)) throw invalid('JWKS response has no keys');
  return body.keys;
}

// Validates signature (RS256 against OpenAI's JWKS), issuer, audience, expiry
// and — on an interactive sign-in — the nonce saved for that attempt.
// Refresh responses may carry an ID token without our nonce, so `nonce` is
// optional and only enforced when provided.
//
// `now` and `jwks` are injectable for tests; production fetches the JWKS.
export async function validateIdToken(idToken, {
  clientId,
  nonce,
  jwks,
  fetchImpl = fetch,
  now = () => Date.now()
} = {}) {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);

  if (header.alg !== 'RS256') throw invalid(`unsupported ID token algorithm: ${header.alg}`);

  const keys = jwks ?? await fetchJwks(fetchImpl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw invalid('ID token signing key not found in JWKS');

  let ok = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    ok = verify('RSA-SHA256', Buffer.from(signingInput), key, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw invalid('ID token signature verification failed');

  if (payload.iss !== AUTH_ISSUER) throw invalid('ID token issuer mismatch');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!clientId || !audiences.includes(clientId)) throw invalid('ID token audience does not match the issued client ID');

  const nowSeconds = Math.floor(now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw invalid('ID token expired');
  }

  if (nonce !== undefined && payload.nonce !== nonce) throw invalid('ID token nonce mismatch');

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw invalid('ID token has no subject');

  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    issuer: payload.iss
  };
}
