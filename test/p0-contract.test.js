import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessage, ROLES } from '../src/core/message.js';
import { Conversation } from '../src/core/conversation.js';
import {
  ChatCoreError,
  normalizeError,
  textDelta,
  done,
  failed,
  isChatEvent
} from '../src/core/chat-event.js';
import { CancelToken } from '../src/core/cancel-token.js';
import { ProviderRegistry } from '../src/core/provider-registry.js';

test('createMessage accepts known roles and rejects unknown ones', () => {
  for (const role of ROLES) {
    const message = createMessage({ role, content: 'hello' });
    assert.equal(message.role, role);
    assert.equal(message.content, 'hello');
  }
  assert.throws(() => createMessage({ role: 'tool', content: 'x' }), TypeError);
});

test('createMessage rejects empty or non-string content', () => {
  assert.throws(() => createMessage({ role: 'user', content: '' }), TypeError);
  assert.throws(() => createMessage({ role: 'user', content: 42 }), TypeError);
});

test('system role is structurally supported with no special behavior', () => {
  const message = createMessage({ role: 'system', content: 'be helpful' });
  assert.equal(message.role, 'system');
  assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
});

test('Conversation stores messages in order and prevents external mutation', () => {
  const conversation = new Conversation();
  conversation.addMessage({ role: 'user', content: 'My name is Alex.' });
  conversation.addMessage({ role: 'assistant', content: 'Noted.' });

  const messages = conversation.getMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'My name is Alex.');

  assert.throws(() => { messages.push(createMessage({ role: 'user', content: 'x' })); });
  assert.throws(() => { messages[0].content = 'tampered'; });
  assert.equal(conversation.getMessages().length, 2);
});

test('chat event factories produce frozen, well-shaped events', () => {
  assert.deepEqual(textDelta('hi'), { type: 'TextDelta', text: 'hi' });
  assert.deepEqual(done('complete'), { type: 'Done', reason: 'complete' });
  assert.throws(() => done('bogus'), TypeError);

  const err = new ChatCoreError({ code: 'boom', message: 'boom happened' });
  const failedEvent = failed(err);
  assert.equal(failedEvent.type, 'Failed');
  assert.equal(failedEvent.error, err);
  assert.throws(() => failed(new Error('raw provider error')), TypeError);
});

test('normalizeError never leaks a raw provider error object into ChatCoreError', () => {
  const raw = new Error('socket hang up');
  raw.someProviderSpecificField = { secret: true };

  const normalized = normalizeError(raw);
  assert.ok(normalized instanceof ChatCoreError);
  assert.equal(normalized.message, 'socket hang up');
  assert.equal(normalized.code, 'provider_error');
  assert.equal('someProviderSpecificField' in normalized, false);
  assert.equal('cause' in normalized, false);
});

test('isChatEvent distinguishes valid core events from arbitrary values', () => {
  assert.equal(isChatEvent(textDelta('x')), true);
  assert.equal(isChatEvent(done('complete')), true);
  assert.equal(isChatEvent({ type: 'weird' }), false);
  assert.equal(isChatEvent(null), false);
});

test('CancelToken exposes a standard AbortSignal and reflects cancellation', () => {
  const token = new CancelToken();
  assert.equal(token.isCancelled, false);
  token.cancel();
  assert.equal(token.isCancelled, true);
  assert.equal(token.signal.aborted, true);
});

test('ProviderRegistry registers and resolves providers, rejecting unknown ids', () => {
  const registry = new ProviderRegistry();
  const provider = { send: () => {} };
  registry.register('local', provider);
  assert.equal(registry.get('local'), provider);
  assert.throws(() => registry.get('missing'), ChatCoreError);
});
