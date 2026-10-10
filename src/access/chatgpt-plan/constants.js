// Fixed endpoints and values for "Sign in with ChatGPT" plan usage
// (OpenAI open-source/local-tool route, preview as of 2026-09-29).
// Source: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// Kept in one place so a protocol change is a one-file edit.

export const AUTH_ISSUER = 'https://auth.openai.com';
export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const REVOKE_URL = 'https://auth.openai.com/api/accounts/oauth/revoke';
export const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';

// The OAuth resource and the inference base URL are the same value.
export const RESOURCE = 'https://api.openai.com/v1';

// First-time sign-in registers a new client; afterwards the issued id is reused.
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';

// The last scope is the one that actually authorizes plan usage. The user can
// decline it on the consent screen while still signing in, so it is always
// checked explicitly instead of being assumed from a successful login.
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = Object.freeze([
  'openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE
]);

// Loopback redirect: scheme, host and path are fixed; only the port may vary
// between sign-ins. `localhost` is rejected by the authorization server.
export const REDIRECT_HOST = '127.0.0.1';
export const REDIRECT_PATH = '/auth/callback';
export const DEFAULT_REDIRECT_PORT = 1455;

export const AGENT_NAME = 'VSP Chat Core';

// Refresh slightly before expiry so a request never starts with a token that
// dies mid-stream.
export const REFRESH_SKEW_MS = 60_000;
