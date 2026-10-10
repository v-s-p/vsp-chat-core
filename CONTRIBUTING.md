# Contributing

Thanks for helping. A few ground rules keep the core small and trustworthy:

1. **Keep the contract stable.** `send(messages, cancelToken) -> TextDelta | Done | Failed` is the product. If a feature needs to change it, open an issue first.
2. **Provider details stay in adapters.** No wire formats, raw errors or provider messages in `src/core`.
3. **Tests with every change.** `npm test` must pass. Use injected `fetch` fakes — tests never call real services or use real credentials.
4. **No dependencies without discussion.** The core runs on plain Node 22.
5. **Never commit credentials**, tokens, personal personas or logs containing them.

Report security issues privately — see [SECURITY.md](SECURITY.md).
