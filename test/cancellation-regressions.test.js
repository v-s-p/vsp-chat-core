import test from 'node:test';
import assert from 'node:assert/strict';

import { runChatStream } from '../src/core/run-chat-stream.js';
import { CancelToken } from '../src/core/cancel-token.js';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible-adapter.js';

// Registers a process-level 'unhandledRejection' listener for the duration
// of fn(), so a rejection nothing else catches is observed here instead of
// crashing the test process. Always removed afterward, never left global.
async function runWithUnhandledRejectionGuard(fn) {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await fn();
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
  return unhandled;
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// HARDENING (not a confirmed historical crash) ------------------------------
// This scenario was originally suspected as a second crash cause (a .catch()
// attached to iterator.next() rather than to the exact promise passed into
// Promise.race). Verified empirically here: with the pre-fix code restored,
// this test still passes — Promise.race attaches its own internal handler to
// every promise it races, which already prevents an unhandled rejection even
// for the "losing" side. The suspected bug was never actually reachable; the
// real, reproducible crash was solely the reader.cancel() one below. This
// test is kept as a permanent guard against a future refactor reintroducing
// a genuinely unhandled promise here, not as proof a bug was fixed.
test('HARDENING: a provider promise that rejects after losing the cancellation race does not crash the process', async () => {
  let rejectPendingNext;
  let nextCallCount = 0;
  const provider = {
    send() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              nextCallCount += 1;
              return new Promise((_resolve, reject) => {
                rejectPendingNext = reject;
              });
            }
          };
        }
      };
    }
  };

  const token = new CancelToken();
  const events = [];

  const unhandled = await runWithUnhandledRejectionGuard(async () => {
    const streamPromise = (async () => {
      for await (const event of runChatStream(provider, [], token)) {
        events.push(event);
      }
    })();

    // raceNext registers its abort listener synchronously, before any
    // microtask tick, so cancelling right here is guaranteed to be observed
    // by the still-pending first next() call rather than racing it by luck.
    token.cancel();

    await streamPromise;

    // Only now — after the consumer already received Done(cancelled) and
    // fully finished iterating — does the provider's pending promise reject,
    // reproducing the "late" rejection from the original crash.
    rejectPendingNext(new Error('late provider rejection after cancellation'));

    await flushMicrotasks();
  });

  assert.deepEqual(events, [{ type: 'Done', reason: 'cancelled' }]);
  assert.equal(nextCallCount, 1, 'guard must not pull a second event from the provider after cancelling');
  assert.deepEqual(unhandled, [], 'the late provider rejection must not become an unhandled rejection');
});

// REGRESSION (confirmed) -----------------------------------------------------
// OpenAICompatibleAdapter's cleanup used `try { reader.cancel(); } catch {}`,
// which only catches a *synchronous* throw. reader.cancel() returns a
// Promise; when it rejected (as a real stream does once already erroring
// from a fetch-level abort), that rejection was never awaited or caught and
// crashed the process. Fixed with `await reader.cancel().catch(() => {})`.
test('REGRESSION: reader.cancel() rejecting during adapter cleanup does not crash the process', async () => {
  let rejectPendingRead;
  let readCalledResolve;
  const readCalled = new Promise((resolve) => { readCalledResolve = resolve; });

  const fakeReader = {
    read: () => {
      readCalledResolve();
      return new Promise((_resolve, reject) => { rejectPendingRead = reject; });
    },
    cancel: () => Promise.reject(new Error('cannot cancel: stream already errored'))
  };

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: { getReader: () => fakeReader },
    text: async () => ''
  });

  const adapter = new OpenAICompatibleAdapter({
    baseURL: 'http://fake.local/v1',
    model: 'test-model',
    fetchImpl
  });

  const token = new CancelToken();
  const events = [];

  const unhandled = await runWithUnhandledRejectionGuard(async () => {
    const streamPromise = (async () => {
      for await (const event of runChatStream(adapter, [{ role: 'user', content: 'hi' }], token)) {
        events.push(event);
      }
    })();

    // Deterministically wait until the adapter is suspended at its own
    // `await reader.read()` — not a fixed sleep — before cancelling.
    await readCalled;

    token.cancel();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    rejectPendingRead(abortError);

    await streamPromise;
    await flushMicrotasks();
  });

  assert.deepEqual(events, [{ type: 'Done', reason: 'cancelled' }]);
  assert.deepEqual(unhandled, [], 'reader.cancel() rejecting must not become an unhandled rejection');
});
