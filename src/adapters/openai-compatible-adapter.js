import { textDelta, done, failed, normalizeError, ChatCoreError } from '../core/chat-event.js';

// Generic OpenAI-compatible streaming adapter — not Ollama-specific.
// Any /v1/chat/completions-shaped endpoint (Ollama, LM Studio, ...) works
// through the same baseURL/model/apiKey configuration.
export class OpenAICompatibleAdapter {
  #baseURL;
  #model;
  #apiKey;
  #fetchImpl;

  constructor({ baseURL, model, apiKey, fetchImpl = fetch } = {}) {
    if (typeof baseURL !== 'string' || baseURL.length === 0) {
      throw new TypeError('OpenAICompatibleAdapter requires a baseURL');
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('OpenAICompatibleAdapter requires a model');
    }
    this.#baseURL = baseURL.replace(/\/+$/, '');
    this.#model = model;
    this.#apiKey = apiKey;
    this.#fetchImpl = fetchImpl;
  }

  async *send(messages, cancelToken) {
    const url = `${this.#baseURL}/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;

    let response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.#model,
          stream: true,
          messages: messages.map(({ role, content }) => ({ role, content }))
        }),
        signal: cancelToken?.signal
      });
    } catch (err) {
      // An aborted fetch throws too; let runChatStream's own cancellation
      // race decide Done(cancelled) instead of reporting it as a Failed.
      if (cancelToken?.isCancelled) return;
      yield failed(normalizeError(err, 'network_error'));
      return;
    }

    if (!response.ok) {
      // The error body is never read (we don't want provider-specific error
      // payloads crossing into the core), but it must still be released so the
      // underlying connection isn't left dangling.
      await response.body?.cancel().catch(() => {});
      yield failed(new ChatCoreError({
        code: 'http_error',
        message: `provider responded with HTTP ${response.status}`,
        retryable: response.status >= 500
      }));
      return;
    }

    if (!response.body) {
      yield failed(new ChatCoreError({
        code: 'invalid_provider_stream',
        message: 'provider response had no body'
      }));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (err) {
          if (cancelToken?.isCancelled) return;
          yield failed(normalizeError(err, 'network_error'));
          return;
        }

        const { value, done: streamDone } = readResult;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          // Normalize CRLF to LF on the accumulated buffer (not the raw
          // chunk in isolation): a lone trailing \r from one chunk and a
          // leading \n from the next both land in this same buffer before
          // the replace runs, so a CRLF split across chunk boundaries is
          // still collapsed correctly. This is an OpenAI-compatible adapter,
          // not Ollama-specific, so it must not assume LF-only servers.
          buffer = buffer.replace(/\r\n/g, '\n');
        }

        // SSE events are separated by a blank line; tolerate the boundary
        // between two chunks falling anywhere, including mid-line.
        let separatorIndex;
        while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();

            if (payload === '[DONE]') {
              yield done('complete');
              return;
            }

            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              yield failed(new ChatCoreError({
                code: 'malformed_provider_data',
                message: 'could not parse provider SSE payload'
              }));
              return;
            }

            const choice = parsed?.choices?.[0];
            const content = choice?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              yield textDelta(content);
            }

            if (choice?.finish_reason) {
              // Terminal here; if a trailing [DONE] event also arrives we
              // never see it because we return before the next read.
              yield done('complete');
              return;
            }
          }
        }

        if (streamDone) return; // runChatStream normalizes this to Failed
      }
    } finally {
      // reader.cancel() returns a promise, not a synchronous call: a bare
      // try/catch here does not observe its rejection (e.g. when the stream
      // is already erroring from the fetch-level abort), which previously
      // surfaced as a process-crashing unhandled rejection during Stop.
      await reader.cancel().catch(() => {});
    }
  }
}
