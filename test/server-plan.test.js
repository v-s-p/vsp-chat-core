import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatCoreServer, LISTEN_HOST } from '../src/server/server.js';
import { loadServerOptions } from '../src/config/chat-config.js';
import { jsonResponse, sseResponse, sse, routedFetch } from './helpers/plan-fakes.js';

const fakeSession = (signedIn = true) => ({
  status: async () => ({ signedIn, planScope: signedIn, email: 'owner@example.com', loginPending: false }),
  getAccessToken: async () => 'tok',
  startLogin: async () => ({ authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?x=1', completion: new Promise(() => {}) }),
  logout: async () => ({ signedIn: false })
});

async function start(options) {
  const server = createChatCoreServer(options);
  await new Promise((r) => server.listen(0, LISTEN_HOST, r));
  const base = `http://${LISTEN_HOST}:${server.address().port}`;
  return { base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {})
});

async function readEvents(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
}

async function personaFile(text) {
  const dir = await mkdtemp(join(tmpdir(), 'persona-'));
  const path = join(dir, 'my-persona.md');
  await writeFile(path, text);
  return path;
}

function planFetch(onResponses) {
  return routedFetch([
    ['https://api.openai.com/v1/models', () => jsonResponse(200, { data: [
      { slug: 'gpt-a', display_name: 'A', visibility: 'list' },
      { slug: 'gpt-b', display_name: 'B', visibility: 'list' }
    ] })],
    ['https://api.openai.com/v1/responses', (url, init) => {
      onResponses?.(JSON.parse(init.body));
      return sseResponse([sse({ type: 'response.output_text.delta', delta: 'Selam' }), sse({ type: 'response.completed' })]);
    }]
  ]);
}

test('chat over the plan: persona goes out as instructions, never stored; history resent next turn', async () => {
  const bodies = [];
  const app = await start({
    provider: 'chatgpt-plan', planSession: fakeSession(), fetchImpl: planFetch((b) => bodies.push(b)),
    personaFile: await personaFile('Sen Aria\'sın.')
  });
  try {
    const first = await readEvents(await postJson(`${app.base}/api/chat`, { text: 'Merhaba' }));
    assert.deepEqual(first, [{ type: 'TextDelta', text: 'Selam' }, { type: 'Done', reason: 'complete' }]);
    await readEvents(await postJson(`${app.base}/api/chat`, { text: 'Nasılsın?' }));

    assert.equal(bodies[0].model, 'gpt-a', 'first listed model auto-selected');
    assert.equal(bodies[1].instructions, 'Sen Aria\'sın.');
    assert.deepEqual(bodies[1].input, [
      { role: 'user', content: 'Merhaba' },
      { role: 'assistant', content: 'Selam' },
      { role: 'user', content: 'Nasılsın?' }
    ]);
  } finally {
    await app.close();
  }
});

test('model selection only accepts models the account actually has', async () => {
  const bodies = [];
  const app = await start({ provider: 'chatgpt-plan', planSession: fakeSession(), fetchImpl: planFetch((b) => bodies.push(b)) });
  try {
    assert.equal((await postJson(`${app.base}/api/model`, { id: 'made-up' })).status, 400);
    assert.equal((await postJson(`${app.base}/api/model`, { id: 'gpt-b' })).status, 200);
    await readEvents(await postJson(`${app.base}/api/chat`, { text: 'x' }));
    assert.equal(bodies[0].model, 'gpt-b');
  } finally {
    await app.close();
  }
});

test('cross-site requests are rejected (no plan usage from other web pages)', async () => {
  let called = false;
  const app = await start({ provider: 'chatgpt-plan', planSession: fakeSession(), fetchImpl: async () => { called = true; } });
  try {
    const foreign = await postJson(`${app.base}/api/chat`, { text: 'x' }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    const simple = await fetch(`${app.base}/api/chat`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"text":"x"}' });
    assert.equal(simple.status, 403, 'non-JSON (preflight-free) POST is refused');
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test('status reports sign-in, model and persona; login returns the authorize URL', async () => {
  const app = await start({ provider: 'chatgpt-plan', planSession: fakeSession(false), fetchImpl: planFetch(), planModel: 'gpt-b' });
  try {
    const status = await (await fetch(`${app.base}/api/status`)).json();
    assert.equal(status.provider, 'chatgpt-plan');
    assert.equal(status.auth.signedIn, false);
    assert.equal(status.model, 'gpt-b');
    assert.equal(status.persona, 'example');
    const login = await (await postJson(`${app.base}/api/auth/login`)).json();
    assert.match(login.authorizeUrl, /^https:\/\/auth\.openai\.com\//);
  } finally {
    await app.close();
  }
});

test('local (P1) mode hides plan-only routes', async () => {
  const app = await start({ provider: 'local', localConfig: { baseURL: 'http://127.0.0.1:1/v1', model: 'm' } });
  try {
    assert.equal((await postJson(`${app.base}/api/auth/login`)).status, 404);
    assert.equal((await fetch(`${app.base}/api/models`)).status, 404);
    assert.equal((await (await fetch(`${app.base}/api/status`)).json()).provider, 'local');
  } finally {
    await app.close();
  }
});

test('server options: CLI flags beat env; unknown provider rejected; default port avoids 8787', () => {
  assert.deepEqual(loadServerOptions(['--provider', 'chatgpt-plan', '--persona=D:\\p\\f.md'], { CHAT_CORE_PROVIDER: 'local' }),
    { provider: 'chatgpt-plan', port: 8790, personaFile: 'D:\\p\\f.md', planModel: undefined });
  assert.throws(() => loadServerOptions(['--provider', 'gemini'], {}), TypeError);
});
