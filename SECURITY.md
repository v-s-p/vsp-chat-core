# Security

Please do **not** open public issues for security problems. Use GitHub's private vulnerability reporting on this repository instead.

Design guarantees we treat as security-relevant:

- The server listens on `127.0.0.1` only and refuses cross-site / non-JSON state-changing requests.
- ChatGPT credentials are stored per user outside the repository, written atomically with owner-only permissions, and revoked on sign-out.
- ID tokens are verified (signature, issuer, audience, expiry, nonce) before any credential is stored; the plan permission is checked explicitly.
- Provider error bodies and messages are never forwarded to the UI.
