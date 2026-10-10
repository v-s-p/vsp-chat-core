import { randomBytes, createHash } from 'node:crypto';

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function randomToken(bytes = 32) {
  return base64url(randomBytes(bytes));
}

// RFC 7636: verifier is 43-128 chars of unreserved characters; 32 random
// bytes base64url-encoded gives exactly 43.
export function createPkcePair() {
  const verifier = randomToken(32);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}
