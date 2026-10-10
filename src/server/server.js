import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { Conversation } from '../core/conversation.js';
import { ProviderRegistry } from '../core/provider-registry.js';
import { CancelToken } from '../core/cancel-token.js';
import { runChatStream } from '../core/run-chat-stream.js';
import { ChatCoreError } from '../core/chat-event.js';
import { OpenAICompatibleAdapter } from '../adapters/openai-compatible-adapter.js';
import { ResponsesAdapter, listPlanModels } from '../adapters/responses-adapter.js';
import { PlanSession } from '../access/chatgpt-plan/plan-session.js';
import { loadChatConfig, loadServerOptions } from '../config/chat-config.js';
import { loadPersona, EXAMPLE_PERSONA } from '../config/persona.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'public');

// Local, single-user harness. It listens on 127.0.0.1 only: with the
// chatgpt-plan provider, anyone who can reach /api/chat spends the owner's
// ChatGPT plan, so it must never be exposed on the network.
export const LISTEN_HOST = '127.0.0.1';

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function errorJson(res, status, err) {
  json(res, status, { error: { code: err?.code || 'internal_error', message: err?.message || 'internal error' } });
}

function sendEvent(res, event) {
  const wire = event.type === 'Failed'
    ? { type: 'Failed', error: { code: event.error.code, message: event.error.message, retryable: event.error.retryable } }
    : event;
  res.write(`data: ${JSON.stringify(wire)}\n\n`);
}

// Blocks cross-site requests from web pages the owner happens to have open:
// state-changing calls must be JSON (forcing a CORS preflight, which this
// server never answers) and any Origin header must be this server itself.
function isSameOriginJson(req) {
  if (req.method === 'GET') return true;
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${req.headers.host}`;
}

export function createChatCoreServer({
  provider = 'local',
  localConfig = loadChatConfig(),
  planSession = new PlanSession(),
  personaFile = EXAMPLE_PERSONA,
  planModel,
  fetchImpl = fetch
} = {}) {
  const registry = new ProviderRegistry();
  let conversation = new Conversation();
  // A Set, not a single slot: Stop must cancel every in-flight generation
  // even if a second request ever overlaps the first.
  const activeCancelTokens = new Set();
  let selectedModel = planModel;

  if (provider === 'local') {
    registry.register('local', new OpenAICompatibleAdapter(localConfig));
  }

  // docs/DESIGN.md §3: a different model is a different provider instance.
  const getAccessToken = () => planSession.getAccessToken();
  function registerPlanModel(model) {
    registry.register('chatgpt-plan', new ResponsesAdapter({ model, getAccessToken, fetchImpl }));
    selectedModel = model;
  }
  if (provider === 'chatgpt-plan' && selectedModel) registerPlanModel(selectedModel);

  async function ensurePlanProvider() {
    if (selectedModel) return;
    const models = await listPlanModels({ getAccessToken, fetchImpl });
    if (models.length === 0) {
      throw new ChatCoreError({ code: 'plan_no_models', message: 'no models are available to this ChatGPT account' });
    }
    registerPlanModel(models[0].id);
  }

  async function handleChat(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { error: 'invalid_json_body' });
      return;
    }

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      json(res, 400, { error: 'text is required' });
      return;
    }

    const cancelToken = new CancelToken();
    activeCancelTokens.add(cancelToken);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });

    // Bound to this request: a /api/reset during generation must not let
    // the late assistant reply leak into the new conversation.
    const turnConversation = conversation;
    turnConversation.addMessage({ role: 'user', content: text });

    let assistantText = '';
    try {
      let chatProvider;
      let outgoing = turnConversation.getMessages();
      try {
        if (provider === 'chatgpt-plan') {
          await ensurePlanProvider();
          const persona = await loadPersona(personaFile);
          if (persona) outgoing = [persona.message, ...outgoing];
        }
        chatProvider = registry.get(provider);
      } catch (err) {
        sendEvent(res, { type: 'Failed', error: err instanceof ChatCoreError ? err : new ChatCoreError({ code: 'setup_failed', message: err?.message }) });
        return;
      }

      for await (const event of runChatStream(chatProvider, outgoing, cancelToken)) {
        if (event.type === 'TextDelta') assistantText += event.text;
        sendEvent(res, event);
      }
    } finally {
      activeCancelTokens.delete(cancelToken);
      if (assistantText) turnConversation.addMessage({ role: 'assistant', content: assistantText });
      res.end();
    }
  }

  async function handleStatus(res) {
    const status = { provider };
    if (provider === 'chatgpt-plan') {
      status.auth = await planSession.status();
      status.model = selectedModel ?? null;
      try {
        status.persona = (await loadPersona(personaFile))?.name ?? null;
      } catch {
        status.persona = null;
        status.personaError = 'persona file could not be read';
      }
    } else {
      status.model = localConfig.model;
    }
    json(res, 200, status);
  }

  const routes = {
    'GET /api/status': (req, res) => handleStatus(res),
    'POST /api/chat': handleChat,
    'POST /api/cancel': (req, res) => {
      for (const token of activeCancelTokens) token.cancel();
      res.writeHead(204).end();
    },
    'POST /api/reset': (req, res) => {
      for (const token of activeCancelTokens) token.cancel();
      conversation = new Conversation();
      res.writeHead(204).end();
    },
    'POST /api/auth/login': async (req, res) => {
      const { authorizeUrl, completion } = await planSession.startLogin();
      // Completion is observed through /api/status polling; failures are
      // remembered so the UI can show why sign-in did not finish.
      completion.then(() => { lastLoginError = null; }, (err) => { lastLoginError = { code: err.code, message: err.message }; });
      lastLoginError = null;
      json(res, 200, { authorizeUrl });
    },
    'GET /api/auth/last-error': (req, res) => json(res, 200, { error: lastLoginError }),
    'POST /api/auth/logout': async (req, res) => {
      for (const token of activeCancelTokens) token.cancel();
      json(res, 200, await planSession.logout());
    },
    'GET /api/models': async (req, res) => {
      json(res, 200, { models: await listPlanModels({ getAccessToken, fetchImpl }), selected: selectedModel ?? null });
    },
    'POST /api/model': async (req, res) => {
      const body = await readJsonBody(req);
      const models = await listPlanModels({ getAccessToken, fetchImpl });
      if (!models.some((m) => m.id === body?.id)) {
        json(res, 400, { error: { code: 'unknown_model', message: 'model is not available to this account' } });
        return;
      }
      registerPlanModel(body.id);
      json(res, 200, { selected: selectedModel });
    }
  };
  let lastLoginError = null;
  const planOnly = new Set(['POST /api/auth/login', 'GET /api/auth/last-error', 'POST /api/auth/logout', 'GET /api/models', 'POST /api/model']);

  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        const html = await readFile(join(publicDir, 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const route = routes[key];
      if (!route || (planOnly.has(key) && provider !== 'chatgpt-plan')) {
        res.writeHead(404).end('not found');
        return;
      }
      if (!isSameOriginJson(req)) {
        json(res, 403, { error: { code: 'cross_origin_rejected', message: 'requests must come from the chat-core page' } });
        return;
      }
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) {
        errorJson(res, err instanceof ChatCoreError ? 400 : 500, err instanceof ChatCoreError ? err : null);
      } else {
        res.end();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = loadServerOptions();
  createChatCoreServer({
    provider: options.provider,
    personaFile: options.personaFile,
    planModel: options.planModel
  }).listen(options.port, LISTEN_HOST, () => {
    console.log(`chat-core (${options.provider}) listening on http://${LISTEN_HOST}:${options.port}`);
  });
}
