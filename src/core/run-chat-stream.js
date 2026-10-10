import { done, failed, normalizeError, isChatEvent } from './chat-event.js';

// Races the provider's next event against cancellation so a pending/slow
// provider.next() can't block a Stop action. Checks cancellation first so an
// already-cancelled token never triggers another pull from the provider.
async function raceNext(iterator, cancelToken) {
  if (cancelToken?.isCancelled) {
    return { type: 'cancelled' };
  }

  // Race against this exact promise object, not iterator.next() directly:
  // Promise.race attaches its own handler to whatever is passed in, so the
  // .catch() below must sit on the same instance or a rejection that loses
  // the race (because cancellation won first) is left unhandled and crashes
  // the process.
  const mappedNext = iterator.next().then((value) => ({ type: 'value', value }));
  mappedNext.catch(() => {}); // avoid an unhandled rejection if cancellation wins the race

  if (!cancelToken) {
    return await mappedNext;
  }

  let onAbort;
  const abortPromise = new Promise((resolve) => {
    onAbort = () => resolve({ type: 'cancelled' });
    cancelToken.signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([mappedNext, abortPromise]);
  } finally {
    cancelToken.signal.removeEventListener('abort', onAbort);
  }
}

// Best-effort: forces the provider's async generator through its finally
// blocks (e.g. releasing a stream reader) instead of leaving it suspended.
async function safeReturn(iterator) {
  if (typeof iterator.return === 'function') {
    try {
      await iterator.return();
    } catch {
      // cleanup failures must not surface as a second terminal event
    }
  }
}

// Core-side guarantee layer: wraps a ChatProvider's raw event stream so the
// consumer can trust it regardless of provider correctness. Guarantees:
//   - exactly one terminal event (Done or Failed), always last
//   - no events are ever exposed after that terminal event
//   - provider throws / malformed events / missing terminal events all
//     normalize to Failed(ChatCoreError), never a raw provider error
//   - cancellation (before or during the stream) short-circuits to
//     Done(cancelled)
export async function* runChatStream(provider, messages, cancelToken) {
  if (cancelToken?.isCancelled) {
    yield done('cancelled');
    return;
  }

  let iterator;
  try {
    iterator = provider.send(messages, cancelToken)[Symbol.asyncIterator]();
  } catch (err) {
    yield failed(normalizeError(err));
    return;
  }

  try {
    while (true) {
      const outcome = await raceNext(iterator, cancelToken);

      if (outcome.type === 'cancelled') {
        await safeReturn(iterator);
        yield done('cancelled');
        return;
      }

      const { value, done: iterDone } = outcome.value;

      if (iterDone) {
        yield failed(normalizeError(
          new Error('provider stream ended without a terminal event'),
          'invalid_provider_stream'
        ));
        return;
      }

      if (!isChatEvent(value)) {
        await safeReturn(iterator);
        yield failed(normalizeError(
          new Error('provider emitted an invalid event'),
          'invalid_provider_event'
        ));
        return;
      }

      if (value.type === 'TextDelta') {
        yield value;
        continue;
      }

      // Done or Failed: first terminal event wins. We never call next()
      // again after this, so anything the provider yields afterward is
      // structurally unreachable rather than merely ignored.
      await safeReturn(iterator);
      yield value;
      return;
    }
  } catch (err) {
    yield failed(normalizeError(err));
  }
}
