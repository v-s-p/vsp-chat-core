import test from 'node:test';
import assert from 'node:assert/strict';

import { runChatStream } from '../src/core/run-chat-stream.js';
import { textDelta, done, failed, ChatCoreError } from '../src/core/chat-event.js';
import { CancelToken } from '../src/core/cancel-token.js';

async function collect(provider, messages = [], cancelToken) {
  const events = [];
  for await (const event of runChatStream(provider, messages, cancelToken)) {
    events.push(event);
  }
  return events;
}

function terminalEvents(events) {
  return events.filter((e) => e.type === 'Done' || e.type === 'Failed');
}

test('GOOD provider: passes through deltas and terminates exactly once with Done(complete)', async () => {
  const provider = {
    async *send() {
      yield textDelta('Mer');
      yield textDelta('haba');
      yield done('complete');
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['TextDelta', 'TextDelta', 'Done']);
  assert.equal(terminalEvents(events).length, 1);
  assert.equal(events.at(-1).reason, 'complete');
});

test('GOOD provider: a Failed event it emits itself passes through unchanged and ends iteration', async () => {
  const domainError = new ChatCoreError({ code: 'rate_limited', message: 'slow down', retryable: true });
  const provider = {
    async *send() {
      yield textDelta('partial');
      yield failed(domainError);
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['TextDelta', 'Failed']);
  assert.equal(events.at(-1).error, domainError);
  assert.equal(terminalEvents(events).length, 1);
});

test('BAD provider: ends without a terminal event produces a normalized Failed', async () => {
  const provider = {
    async *send() {
      yield textDelta('partial');
      // no Done/Failed — provider just stops
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['TextDelta', 'Failed']);
  assert.ok(events.at(-1).error instanceof ChatCoreError);
  assert.equal(terminalEvents(events).length, 1);
});

test('BAD provider: raw throw during iteration is converted to Failed(ChatCoreError)', async () => {
  const provider = {
    async *send() {
      yield textDelta('before crash');
      throw new Error('raw provider socket error');
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['TextDelta', 'Failed']);
  const failure = events.at(-1);
  assert.ok(failure.error instanceof ChatCoreError);
  assert.equal(failure.error.message, 'raw provider socket error');
  assert.equal(terminalEvents(events).length, 1);
});

test('BAD provider: throwing synchronously from send() is converted to Failed', async () => {
  const provider = {
    send() {
      throw new Error('cannot construct stream');
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['Failed']);
  assert.equal(events.at(-1).error.message, 'cannot construct stream');
});

test('BAD provider: a malformed event object is converted to Failed rather than passed through', async () => {
  const provider = {
    async *send() {
      yield { not: 'a chat event' };
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['Failed']);
  assert.ok(events.at(-1).error instanceof ChatCoreError);
});

test('BAD provider: events emitted after Done are never observed by the consumer', async () => {
  let ranAfterDone = false;
  const provider = {
    async *send() {
      yield done('complete');
      ranAfterDone = true; // would flip if the guard ever resumed the provider past its terminal event
      yield textDelta('should never appear');
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['Done']);
  assert.equal(terminalEvents(events).length, 1);
  assert.equal(ranAfterDone, false, 'guard must never resume the provider past its terminal event');
});

test('BAD provider: a second terminal event (Failed then Done) is never observed by the consumer', async () => {
  let ranAfterFailed = false;
  const provider = {
    async *send() {
      yield failed(new ChatCoreError({ code: 'boom', message: 'boom' }));
      ranAfterFailed = true; // would flip if the guard ever resumed the provider past its terminal event
      yield done('complete');
    }
  };

  const events = await collect(provider);
  assert.deepEqual(events.map((e) => e.type), ['Failed']);
  assert.equal(terminalEvents(events).length, 1);
  assert.equal(ranAfterFailed, false, 'guard must never resume the provider past its terminal event');
});

test('already-cancelled token: stream ends in Done(cancelled) without ever invoking the provider', async () => {
  let sendCalled = false;
  const provider = {
    async *send() {
      sendCalled = true;
      yield textDelta('should not run');
      yield done('complete');
    }
  };

  const token = new CancelToken();
  token.cancel();

  const events = await collect(provider, [], token);
  assert.deepEqual(events, [{ type: 'Done', reason: 'cancelled' }]);
  assert.equal(sendCalled, false);
});

test('cancellation during streaming: stream ends in Done(cancelled), provider cleanup runs, no further deltas leak', async () => {
  let cleanedUp = false;
  const provider = {
    async *send() {
      try {
        yield textDelta('first');
        await new Promise(() => {}); // simulates a chunk that never arrives
        yield textDelta('unreachable');
      } finally {
        cleanedUp = true;
      }
    }
  };

  const token = new CancelToken();
  const stream = runChatStream(provider, [], token);

  const first = await stream.next();
  assert.equal(first.value.type, 'TextDelta');

  token.cancel();

  const second = await stream.next();
  assert.equal(second.done, false);
  assert.deepEqual(second.value, { type: 'Done', reason: 'cancelled' });

  const third = await stream.next();
  assert.equal(third.done, true);

  assert.equal(cleanedUp, true, 'guard must call return() on the provider iterator so its cleanup runs');
});
