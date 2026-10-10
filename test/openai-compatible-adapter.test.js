import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible-adapter.js';
import { ChatCoreError } from '../src/core/chat-event.js';
import { CancelToken } from '../src/core/cancel-token.js';
import { runChatStream } from '../src/core/run-chat-stream.js';

function fakeResponse({ ok = true, status = 200, chunks = [] } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        // Chunks are usually authored as strings for readability; a raw
        // Uint8Array is accepted too, so a test can split a multi-byte
        // UTF-8 sequence at an exact byte offset instead of a string index.
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    }
  });
  return { ok, status, body, text: async () => '' };
}

function adapterWith(chunksOrFactory) {
  const fetchImpl = typeof chunksOrFactory === 'function'
    ? chunksOrFactory
    : async () => fakeResponse({ chunks: chunksOrFactory });
  return new OpenAICompatibleAdapter({
    baseURL: 'http://fake.local/v1',
    model: 'test-model',
    fetchImpl
  });
}

async function collect(adapter, cancelToken) {
  const events = [];
  for await (const event of adapter.send([{ role: 'user', content: 'hi' }], cancelToken)) {
    events.push(event);
  }
  return events;
}

test('multiple SSE data events arriving in a single network chunk are all parsed', async () => {
  const adapter = adapterWith([
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"!"},"finish_reason":null}]}\n\n' +
    'data: [DONE]\n\n'
  ]);

  const events = await collect(adapter);
  assert.deepEqual(events, [
    { type: 'TextDelta', text: 'Hi' },
    { type: 'TextDelta', text: '!' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('CRLF-separated SSE events are parsed identically to LF-separated ones', async () => {
  const adapter = adapterWith([
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"!"},"finish_reason":null}]}\r\n\r\n' +
    'data: [DONE]\r\n\r\n'
  ]);

  const events = await collect(adapter);
  assert.deepEqual(events, [
    { type: 'TextDelta', text: 'Hi' },
    { type: 'TextDelta', text: '!' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('a CRLF separator split across network chunks (\\r in one chunk, \\n in the next) is still recognized', async () => {
  const adapter = adapterWith([
    // The blank-line separator's first \r\n pair is split mid-pair: the lone
    // trailing \r must survive in the buffer and combine with the \n that
    // arrives in the next chunk before CRLF normalization runs.
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\r',
    '\n\r\ndata: [DONE]\r\n\r\n'
  ]);

  const events = await collect(adapter);
  assert.deepEqual(events, [
    { type: 'TextDelta', text: 'Hi' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('a chunk boundary falling inside the literal "data:" prefix is still parsed correctly', async () => {
  const adapter = adapterWith([
    'da',
    'ta: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n'
  ]);

  const events = await collect(adapter);
  assert.deepEqual(events, [
    { type: 'TextDelta', text: 'Hi' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('a multi-byte UTF-8 character split across chunk boundaries decodes correctly', async () => {
  const fullText = 'data: {"choices":[{"delta":{"content":"ş"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  const fullBytes = new TextEncoder().encode(fullText);
  const leadByteOfSh = new TextEncoder().encode('ş')[0]; // 0xC5, unique among the surrounding ASCII bytes
  const splitIndex = fullBytes.indexOf(leadByteOfSh) + 1; // cut immediately after that lead byte

  const adapter = adapterWith(async () => fakeResponse({
    chunks: [fullBytes.slice(0, splitIndex), fullBytes.slice(splitIndex)]
  }));

  const events = await collect(adapter);
  assert.deepEqual(events, [
    { type: 'TextDelta', text: 'ş' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('a response with no body becomes Failed(ChatCoreError)', async () => {
  const adapter = adapterWith(async () => ({ ok: true, status: 200, body: null, text: async () => '' }));

  const events = await collect(adapter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'Failed');
  assert.equal(events[0].error.code, 'invalid_provider_stream');
});

test('an HTTP body that ends without [DONE] or finish_reason surfaces as Failed via runChatStream', async () => {
  const adapter = adapterWith([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
    // stream just closes here — no [DONE], no finish_reason
  ]);

  const events = [];
  for await (const event of runChatStream(adapter, [{ role: 'user', content: 'hi' }], undefined)) {
    events.push(event);
  }
  assert.deepEqual(events.map((e) => e.type), ['TextDelta', 'Failed']);
  assert.equal(events.at(-1).error.code, 'invalid_provider_stream');
});

test('reader.read() rejecting mid-stream when NOT cancelled becomes Failed(network_error), not a crash', async () => {
  const reader = {
    read: () => Promise.reject(new Error('connection reset by peer')),
    cancel: () => Promise.resolve()
  };
  const adapter = adapterWith(async () => ({
    ok: true,
    status: 200,
    body: { getReader: () => reader },
    text: async () => ''
  }));

  const events = await collect(adapter); // no cancelToken — this is a genuine network failure
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'Failed');
  assert.equal(events[0].error.code, 'network_error');
  assert.equal(events[0].error.message, 'connection reset by peer');
});

test('the adapter is stateless across sequential calls: a cancelled request does not affect the next one', async () => {
  let call = 0;
  const fetchImpl = async (_url, options) => {
    call += 1;
    if (call === 1) {
      // Mimics a real fetch+reader: the pending read() only settles once
      // the request's own AbortSignal actually fires.
      const reader = {
        read: () => new Promise((_resolve, reject) => {
          const abortNow = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          // A real fetch/undici reader checks for an already-aborted signal
          // synchronously; this must too, or a signal that fires before
          // read() is even called leaves nothing to reject the promise.
          if (options.signal.aborted) abortNow();
          else options.signal.addEventListener('abort', abortNow, { once: true });
        }),
        cancel: () => Promise.resolve()
      };
      return { ok: true, status: 200, body: { getReader: () => reader }, text: async () => '' };
    }
    return fakeResponse({
      chunks: ['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n', 'data: [DONE]\n\n']
    });
  };

  const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://fake.local/v1', model: 'test-model', fetchImpl });

  const token = new CancelToken();
  const firstEvents = [];
  const firstStream = (async () => {
    for await (const event of runChatStream(adapter, [{ role: 'user', content: 'hi' }], token)) {
      firstEvents.push(event);
    }
  })();
  token.cancel();
  await firstStream;
  assert.deepEqual(firstEvents, [{ type: 'Done', reason: 'cancelled' }]);

  const secondEvents = [];
  for await (const event of runChatStream(adapter, [{ role: 'user', content: 'hi again' }], undefined)) {
    secondEvents.push(event);
  }
  assert.deepEqual(secondEvents, [
    { type: 'TextDelta', text: 'OK' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('a single SSE data event split across multiple network chunks is reassembled', async () => {
  const adapter = adapterWith([
    'data: {"choices":[{"delta":{"conte',
    'nt":"Hi"},"finish_reason":null}]}\n',
    '\n',
    'data: [DONE]\n\n'
  ]);

  const events = await collect(adapter);
  assert.deepEqual(events, [
    { type: 'TextDelta', text: 'Hi' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('finish_reason followed by a trailing [DONE] produces exactly one terminal event', async () => {
  const adapter = adapterWith([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);

  const events = await collect(adapter);
  assert.deepEqual(events, [{ type: 'Done', reason: 'complete' }]);
});

test('malformed JSON in an SSE payload becomes Failed(ChatCoreError), not a thrown error', async () => {
  const adapter = adapterWith(['data: {not valid json\n\n']);

  const events = await collect(adapter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'Failed');
  assert.ok(events[0].error instanceof ChatCoreError);
  assert.equal(events[0].error.code, 'malformed_provider_data');
});

test('non-2xx HTTP response becomes Failed(ChatCoreError), no raw response object leaks', async () => {
  const adapter = adapterWith(async () => fakeResponse({ ok: false, status: 500 }));

  const events = await collect(adapter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'Failed');
  assert.ok(events[0].error instanceof ChatCoreError);
  assert.equal(events[0].error.code, 'http_error');
  assert.equal(events[0].error.retryable, true);
});

test('a fetch/network failure becomes Failed(ChatCoreError), raw error never crosses the boundary', async () => {
  const rawError = new TypeError('fetch failed: ECONNREFUSED');
  const adapter = adapterWith(async () => { throw rawError; });

  const events = await collect(adapter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'Failed');
  assert.ok(events[0].error instanceof ChatCoreError);
  assert.equal(events[0].error.code, 'network_error');
  assert.equal(events[0].error.message, 'fetch failed: ECONNREFUSED');
  assert.equal('someProviderSpecificField' in events[0].error, false);
});

test('a cancelled token causes fetch rejection to be swallowed rather than reported as Failed', async () => {
  const token = new CancelToken();
  token.cancel();
  const adapter = adapterWith(async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const events = await collect(adapter, token);
  assert.deepEqual(events, []); // runChatStream's own guard reports Done(cancelled), not this adapter
});
