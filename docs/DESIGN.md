# VSP Chat Core — design

## 1. Goal

A user writes a message, a real LLM receives it, and a streamed reply appears in the same chat surface — with the LLM swappable behind one contract.

## 2. Contract

```
ChatProvider
    send(messages, cancelToken) -> AsyncIterable<ChatEvent>

Message    { role: 'system' | 'user' | 'assistant', content: string }
ChatEvent  TextDelta(text) | Done('complete' | 'cancelled') | Failed(ChatCoreError)
```

Invariants:

- **Exactly one terminal event**, always last. `runChatStream()` enforces this even if a provider misbehaves (throws, emits garbage, ends silently).
- **Provider details never cross the boundary.** Wire formats, raw errors and provider messages stay in adapters; only a `ChatCoreError { code, message, retryable }` comes out.
- **Cancellable by design.** Cancelling aborts the underlying request and ends with `Done('cancelled')`.
- **The core owns the conversation.** History is kept by the core and resent each turn; provider-side threads are not the source of truth.

## 3. Boundaries

```
UI → server → runChatStream → ChatProvider (adapter) → LLM
                                   ↑
                    access layer (sign-in, tokens)
```

- **Authentication is not part of `send()`.** Adapters receive credentials at construction (e.g. a `getAccessToken` function).
- **A different model is a different provider instance.** Model names never enter the core contract.
- **Personas are instructions, not history.** A persona file is prepended as a `system` message for the provider only.

## 4. ChatGPT plan access

Uses OpenAI's **Sign in with ChatGPT** plan-usage route for open-source tools that run on the user's machine (no approval needed). Source: <https://developers.openai.com/siwc>.

**Sign-in** (`src/access/chatgpt-plan/`)

- OAuth 2.0 authorization code + PKCE (S256), loopback redirect `http://127.0.0.1:1455/auth/callback` (next ports if busy; `localhost` is not accepted).
- First sign-in registers the app (`dynamic_agent_client` → issued client id), later sign-ins reuse it.
- ID token: RS256 signature against OpenAI's JWKS, issuer, audience = issued client id, expiry, nonce.
- The plan scope `chatgpt.tokens.use.direct` is checked explicitly — users can decline it on the consent screen.
- Access tokens last about an hour; refresh tokens rotate, so concurrent refreshes are collapsed into one.
- Storage: atomic, owner-only files outside the repo. `client.json` (issued client id, host id) survives sign-out; `credentials.json` does not.

**Inference** (`src/adapters/responses-adapter.js`)

- `POST /v1/responses` with `store: false`, `stream: true`; full history in `input`; `system` → `instructions` (explicit system items are rejected on this route).
- Success only on `response.completed`.
- Error mapping (provider → core): usage limit → `plan_usage_limit` (never auto-retried), not eligible → `plan_not_eligible`, temporarily unavailable → `plan_temporarily_unavailable` (retryable), unsupported input → `plan_unsupported_request`, credential problems → `plan_auth_rejected`.
- Models: `GET /v1/models`, keep entries with `visibility: "list"`.

**Preview limits (OpenAI)**

- Usage draws from the ChatGPT Work/Codex allowance. Plus: shared 5-hour window + weekly limit; Pro: weekly limit.
- Not supported: audio input, hosted tools (image generation, file search, Code Interpreter, hosted MCP/connectors), `temperature`, `top_p`, `max_output_tokens`, `previous_response_id` over HTTP.
- Supported: your own function/custom tools.

## 5. Local server

- Binds to `127.0.0.1` only. State-changing requests must be same-origin JSON, which blocks other web pages from spending the plan.
- Default port 8790. Flags: `--provider local|chatgpt-plan`, `--persona <file>`, `--model <slug>`, `--port <n>` (env: `CHAT_CORE_PROVIDER`, `CHAT_CORE_PERSONA_FILE`, `CHAT_CORE_PLAN_MODEL`, `CHAT_CORE_PORT`, `CHAT_CORE_CREDENTIALS_DIR`).

## 6. Roadmap

- Tools: own function tools with the full tool-call → result → continue loop.
- More providers behind the same contract (e.g. other subscription sign-ins as they appear).
- Voice as an I/O layer on top of `TextDelta` (sentence splitting, TTS), never inside the core.
