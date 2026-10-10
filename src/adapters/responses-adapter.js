import { textDelta, done, failed, normalizeError, ChatCoreError } from '../core/chat-event.js';
import { readSseData } from './sse-reader.js';

// Provider error codes → core-owned codes. Only the code crosses the
// boundary; provider messages/bodies never do (docs/DESIGN.md §2).
// Source: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
const ERROR_MAP = Object.freeze({
  subscription_sharing_usage_limit_exceeded: { code: 'plan_usage_limit', message: 'ChatGPT plan usage limit reached; see ChatGPT Settings → Usage', retryable: false },
  subscription_sharing_user_not_eligible: { code: 'plan_not_eligible', message: 'this ChatGPT account or workspace cannot use its plan in other apps', retryable: false },
  subscription_sharing_usage_unavailable: { code: 'plan_temporarily_unavailable', message: 'ChatGPT plan usage is temporarily unavailable', retryable: true },
  subscription_sharing_user_unavailable: { code: 'plan_temporarily_unavailable', message: 'ChatGPT plan usage is temporarily unavailable', retryable: true },
  subscription_sharing_unsupported_capability: { code: 'plan_unsupported_request', message: 'the request used a feature not supported on ChatGPT plan usage', retryable: false },
  subscription_sharing_route_not_supported: { code: 'plan_unsupported_request', message: 'endpoint not supported on ChatGPT plan usage', retryable: false },
  subscription_sharing_invalid_user: { code: 'plan_auth_rejected', message: 'ChatGPT rejected the sign-in credentials', retryable: false },
  chatpass_v2_scope_not_authorized: { code: 'plan_scope_missing', message: 'ChatGPT plan usage permission is not granted', retryable: false },
  chatpass_v2_invalid_authorization_context: { code: 'plan_auth_rejected', message: 'ChatGPT rejected the authorization context', retryable: false }
});

function mapProviderError(providerCode, status) {
  const mapped = providerCode && ERROR_MAP[providerCode];
  if (mapped) return new ChatCoreError(mapped);
  if (status === 401) return new ChatCoreError({ code: 'plan_auth_rejected', message: 'ChatGPT rejected the sign-in credentials (HTTP 401)' });
  if (status === 403) return new ChatCoreError({ code: 'plan_forbidden', message: 'ChatGPT refused the request (HTTP 403)' });
  if (status === 503) return new ChatCoreError({ code: 'plan_temporarily_unavailable', message: 'ChatGPT plan usage is temporarily unavailable (HTTP 503)', retryable: true });
  return new ChatCoreError({
    code: status ? 'http_error' : 'provider_error',
    message: status ? `provider responded with HTTP ${status}` : 'provider reported a failure',
    retryable: status >= 500
  });
}

async function readErrorCode(response) {
  try {
    const body = await response.json();
    return body?.error?.code ?? undefined;
  } catch {
    return undefined;
  }
}

// System messages become `instructions`: this route rejects explicit
// `system` role items. Everything else is resent in full each turn, because
// `store: false` means the provider keeps no server-side history.
export function toResponsesRequest(messages, model) {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const input = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map(({ role, content }) => ({ role, content }));
  const body = { model, input, store: false, stream: true };
  if (instructions) body.instructions = instructions;
  return body;
}

// ChatProvider over the OpenAI Responses API, used with a ChatGPT plan access
// token ("Sign in with ChatGPT"). Authentication is injected as a token
// getter at construction — it is not part of send() (docs/DESIGN.md §3).
export class ResponsesAdapter {
  #baseURL;
  #model;
  #getAccessToken;
  #fetchImpl;

  constructor({ baseURL = 'https://api.openai.com/v1', model, getAccessToken, fetchImpl = fetch } = {}) {
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('ResponsesAdapter requires a model');
    }
    if (typeof getAccessToken !== 'function') {
      throw new TypeError('ResponsesAdapter requires a getAccessToken function');
    }
    this.#baseURL = baseURL.replace(/\/+$/, '');
    this.#model = model;
    this.#getAccessToken = getAccessToken;
    this.#fetchImpl = fetchImpl;
  }

  get model() {
    return this.#model;
  }

  async *send(messages, cancelToken) {
    let token;
    try {
      token = await this.#getAccessToken();
    } catch (err) {
      yield failed(normalizeError(err, 'plan_auth_unavailable'));
      return;
    }

    let response;
    try {
      response = await this.#fetchImpl(`${this.#baseURL}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(toResponsesRequest(messages, this.#model)),
        signal: cancelToken?.signal
      });
    } catch (err) {
      if (cancelToken?.isCancelled) return;
      yield failed(normalizeError(err, 'network_error'));
      return;
    }

    if (!response.ok) {
      const providerCode = await readErrorCode(response);
      yield failed(mapProviderError(providerCode, response.status));
      return;
    }

    if (!response.body) {
      yield failed(new ChatCoreError({ code: 'invalid_provider_stream', message: 'provider response had no body' }));
      return;
    }

    const reader = response.body.getReader();
    try {
      try {
        for await (const data of readSseData(reader)) {
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            yield failed(new ChatCoreError({ code: 'malformed_provider_data', message: 'could not parse provider SSE payload' }));
            return;
          }

          switch (event?.type) {
            case 'response.output_text.delta':
              if (typeof event.delta === 'string' && event.delta.length > 0) yield textDelta(event.delta);
              break;
            case 'response.completed':
              // Only this event means success; a stream that just ends is
              // left to runChatStream, which reports it as Failed.
              yield done('complete');
              return;
            case 'response.failed':
              yield failed(mapProviderError(event.response?.error?.code));
              return;
            case 'response.incomplete':
              yield failed(new ChatCoreError({
                code: 'plan_response_incomplete',
                message: `response ended incomplete (${event.response?.incomplete_details?.reason || 'unknown reason'})`
              }));
              return;
            case 'error':
              yield failed(mapProviderError(event.code ?? event.error?.code));
              return;
            default:
              // created/in_progress/output_item/content_part/... carry no text
              break;
          }
        }
      } catch (err) {
        if (cancelToken?.isCancelled) return;
        yield failed(normalizeError(err, 'network_error'));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}

// Lists models available to the signed-in account. Entries with
// visibility other than "list" are hidden, per OpenAI's guidance.
export async function listPlanModels({ baseURL = 'https://api.openai.com/v1', getAccessToken, fetchImpl = fetch }) {
  const token = await getAccessToken();
  let response;
  try {
    response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    });
  } catch (err) {
    throw normalizeError(err, 'network_error');
  }
  if (!response.ok) throw mapProviderError(await readErrorCode(response), response.status);

  const body = await response.json();
  const entries = Array.isArray(body) ? body : (body?.data ?? body?.models ?? []);
  return entries
    .filter((m) => m && (m.visibility === undefined || m.visibility === 'list'))
    .map((m) => ({ id: m.slug ?? m.id, name: m.display_name ?? m.slug ?? m.id }))
    .filter((m) => typeof m.id === 'string' && m.id.length > 0);
}
