# VSP Chat Core

**Talk to your own ChatGPT plan from your own app — no API key, no per-token bill.**

VSP Chat Core is a small, provider-independent streaming chat core. One contract, many brains:

```
send(messages, cancelToken) -> stream of TextDelta | Done | Failed
```

Behind that contract sit swappable adapters:

| Provider | How it is paid | Adapter |
|---|---|---|
| **Your ChatGPT Plus/Pro plan** via [Sign in with ChatGPT](https://developers.openai.com/siwc) | Your existing subscription | `ResponsesAdapter` |
| Any local OpenAI-compatible server (Ollama, LM Studio, …) | Free, on your machine | `OpenAICompatibleAdapter` |

Part of **Project HAV** · [vspintelligence.com](https://vspintelligence.com)

## Quick start

Requires Node 22+.

```bash
git clone https://github.com/v-s-p/vsp-chat-core
cd vsp-chat-core
npm start            # ChatGPT plan
# or
npm run start:local  # local model (CHAT_CORE_BASE_URL, CHAT_CORE_MODEL)
```

Open <http://127.0.0.1:8790>, click **Continue with ChatGPT**, approve in the browser, pick a model, chat.

### Your own persona

A persona is just a text file of instructions. Keep yours outside the repo:

```bash
node src/server/server.js --provider chatgpt-plan --persona /path/to/my-persona.md
```

It is sent as `instructions` on every turn and never stored in the conversation, so you can edit it live.

## What you get

- **Streaming** with a strict guarantee: every reply ends in exactly one `Done` or `Failed`.
- **Stop** at any time — the request is really aborted, partial text is kept.
- **Plan-aware errors**: hitting your plan's usage limit shows a clear message and is never auto-retried.
- **Safe sign-in**: PKCE, loopback redirect, ID token verified against OpenAI's keys, plan permission checked explicitly, rotating refresh handled, revoke on sign-out.
- **Local by design**: the server binds to `127.0.0.1` only and rejects cross-site requests, so no web page can spend your plan. Credentials live per user outside the repo (`%LOCALAPPDATA%\vsp-chat-core` on Windows, `~/.config/vsp-chat-core` elsewhere).

## Know the limits

Plan usage is an OpenAI **preview**. It draws from the same allowance as ChatGPT Work/Codex (Plus: shared 5-hour window + weekly limit). Audio input and OpenAI-hosted tools are not available on this route; your own function tools are. Details: [docs/DESIGN.md](docs/DESIGN.md).

## Not affiliated with OpenAI

This project uses OpenAI's public Sign in with ChatGPT developer route. It is not made, endorsed or supported by OpenAI.

## License

[Apache-2.0](LICENSE). Copyright 2026 Kenan Ataerk / VSP Intelligence.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
