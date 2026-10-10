import test from 'node:test';
import assert from 'node:assert/strict';

import { ResponsesAdapter, toResponsesRequest, listPlanModels } from '../src/adapters/responses-adapter.js';
import { CancelToken } from '../src/core/cancel-token.js';
import { runChatStream } from '../src/core/run-chat-stream.js';
import { ChatCoreError } from '../src/core/chat-event.js';
import { sseResponse, jsonResponse, sse } from './helpers/plan-fakes.js';

const token = async () => 'tok-1';

function adapter(fetchImpl, getAccessToken = token) {
  return new ResponsesAdapter({ model: 'gpt-test', getAccessToken, fetchImpl });
}

async function collect(iterable) {
  const out = [];
  for await (const e of iterable) out.push(e);
  return out;
}

const plain = (events) => events.map((e) => (e.type === 'Failed' ? { type: 'Failed', code: e.error.code } : e));

test('request: system → instructions, history resent, store false, stream true, bearer token', async () => {
  let seen;
  const a = adapter(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return sseResponse([sse({ type: 'response.completed' })]);
  });
  await collect(a.send([
    { role: 'system', content: 'Be Aria.' },
    { role: 'user', content: 'Merhaba' },
    { role: 'assistant', content: 'Selam' },
    { role: 'user', content: 'Adım ne?' }
  ]));
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.init.headers.authorization, 'Bearer tok-1');
  assert.deepEqual(seen.body, {
    model: 'gpt-test',
    instructions: 'Be Aria.',
    input: [
      { role: 'user', content: 'Merhaba' },
      { role: 'assistant', content: 'Selam' },
      { role: 'user', content: 'Adım ne?' }
    ],
    store: false,
    stream: true
  });
});

test('no system message → no instructions field (never a system role item)', () => {
  const body = toResponsesRequest([{ role: 'user', content: 'hi' }], 'm');
  assert.equal('instructions' in body, false);
  assert.ok(body.input.every((i) => i.role !== 'system'));
});

test('text deltas stream and response.completed is the only success terminal', async () => {
  const a = adapter(async () => sseResponse([
    sse({ type: 'response.created' }) + sse({ type: 'response.output_text.delta', delta: 'Mer' }),
    sse({ type: 'response.output_text.delta', delta: 'haba' }),
    sse({ type: 'response.completed', response: {} })
  ]));
  assert.deepEqual(await collect(a.send([{ role: 'user', content: 'hi' }])), [
    { type: 'TextDelta', text: 'Mer' },
    { type: 'TextDelta', text: 'haba' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('CRLF framing and an event split across chunks still parse', async () => {
  const whole = `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ğüş' })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(whole);
  const cut = bytes.length - 8;
  const a = adapter(async () => sseResponse([bytes.slice(0, cut), bytes.slice(cut), sse({ type: 'response.completed' })]));
  assert.deepEqual(await collect(a.send([{ role: 'user', content: 'x' }])), [
    { type: 'TextDelta', text: 'ğüş' },
    { type: 'Done', reason: 'complete' }
  ]);
});

test('usage limit mid-stream: partial text kept, then Failed(plan_usage_limit), not retryable', async () => {
  const a = adapter(async () => sseResponse([
    sse({ type: 'response.output_text.delta', delta: 'Kısmi' }),
    sse({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'provider text' } } })
  ]));
  const events = await collect(a.send([{ role: 'user', content: 'x' }]));
  assert.deepEqual(plain(events), [{ type: 'TextDelta', text: 'Kısmi' }, { type: 'Failed', code: 'plan_usage_limit' }]);
  assert.equal(events[1].error.retryable, false);
  assert.ok(!events[1].error.message.includes('provider text'), 'provider message must not cross the boundary');
});

test('HTTP 429 with structured code before the stream opens → plan_usage_limit', async () => {
  const a = adapter(async () => jsonResponse(429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } }));
  assert.deepEqual(plain(await collect(a.send([{ role: 'user', content: 'x' }]))), [{ type: 'Failed', code: 'plan_usage_limit' }]);
});

test('error code mapping: not eligible, unavailable (retryable), bare 401/403/503', async () => {
  const cases = [
    [403, { error: { code: 'subscription_sharing_user_not_eligible' } }, 'plan_not_eligible', false],
    [503, { error: { code: 'subscription_sharing_usage_unavailable' } }, 'plan_temporarily_unavailable', true],
    [400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'temperature' } }, 'plan_unsupported_request', false],
    [401, {}, 'plan_auth_rejected', false],
    [403, {}, 'plan_forbidden', false],
    [503, {}, 'plan_temporarily_unavailable', true],
    [500, {}, 'http_error', true]
  ];
  for (const [status, body, code, retryable] of cases) {
    const [event] = await collect(adapter(async () => jsonResponse(status, body)).send([{ role: 'user', content: 'x' }]));
    assert.equal(event.error.code, code, `HTTP ${status}`);
    assert.equal(event.error.retryable, retryable, `HTTP ${status} retryable`);
  }
});

test('response.incomplete → Failed(plan_response_incomplete)', async () => {
  const a = adapter(async () => sseResponse([sse({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })]));
  assert.deepEqual(plain(await collect(a.send([{ role: 'user', content: 'x' }]))), [{ type: 'Failed', code: 'plan_response_incomplete' }]);
});

test('stream that ends without response.completed is reported as Failed by runChatStream', async () => {
  const a = adapter(async () => sseResponse([sse({ type: 'response.output_text.delta', delta: 'yarım' })]));
  const events = await collect(runChatStream(a, [{ role: 'user', content: 'x' }]));
  assert.deepEqual(plain(events), [{ type: 'TextDelta', text: 'yarım' }, { type: 'Failed', code: 'invalid_provider_stream' }]);
});

test('token getter failure becomes Failed without any network call', async () => {
  let called = false;
  const a = adapter(async () => { called = true; }, async () => {
    throw new ChatCoreError({ code: 'plan_not_signed_in', message: 'not signed in' });
  });
  assert.deepEqual(plain(await collect(a.send([{ role: 'user', content: 'x' }]))), [{ type: 'Failed', code: 'plan_not_signed_in' }]);
  assert.equal(called, false);
});

test('cancellation mid-stream ends with Done(cancelled) and aborts the request', async () => {
  let signal;
  const a = adapter(async (url, init) => {
    signal = init.signal;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse({ type: 'response.output_text.delta', delta: 'uzun' })));
          init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        }
      })
    };
  });
  const cancel = new CancelToken();
  const events = [];
  for await (const e of runChatStream(a, [{ role: 'user', content: 'x' }], cancel)) {
    events.push(e);
    if (e.type === 'TextDelta') cancel.cancel();
  }
  assert.deepEqual(events, [{ type: 'TextDelta', text: 'uzun' }, { type: 'Done', reason: 'cancelled' }]);
  assert.equal(signal.aborted, true);
});

test('listPlanModels keeps only visibility=list and maps slug/display_name', async () => {
  const models = await listPlanModels({
    getAccessToken: token,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(init.headers.authorization, 'Bearer tok-1');
      return jsonResponse(200, { data: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
        { slug: 'internal-x', display_name: 'Hidden', visibility: 'hide' }
      ] });
    }
  });
  assert.deepEqual(models, [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]);
});
