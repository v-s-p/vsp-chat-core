export class ChatCoreError extends Error {
  constructor({ code = 'unknown_error', message, retryable = false, providerId } = {}) {
    super(message || code);
    this.name = 'ChatCoreError';
    this.code = code;
    this.retryable = Boolean(retryable);
    if (providerId !== undefined) this.providerId = providerId;
  }
}

// Converts any thrown value into a ChatCoreError. Only a plain message
// string is carried over; the raw error object never crosses the boundary.
export function normalizeError(err, code = 'provider_error') {
  if (err instanceof ChatCoreError) return err;
  const message = err instanceof Error && err.message ? err.message : 'unknown chat error';
  return new ChatCoreError({ code, message });
}

export function textDelta(text) {
  if (typeof text !== 'string') {
    throw new TypeError('TextDelta text must be a string');
  }
  return Object.freeze({ type: 'TextDelta', text });
}

const DONE_REASONS = Object.freeze(['complete', 'cancelled']);

export function done(reason) {
  if (!DONE_REASONS.includes(reason)) {
    throw new TypeError(`Done reason must be one of ${DONE_REASONS.join(', ')}`);
  }
  return Object.freeze({ type: 'Done', reason });
}

export function failed(error) {
  if (!(error instanceof ChatCoreError)) {
    throw new TypeError('failed() requires a ChatCoreError; normalize raw errors first');
  }
  return Object.freeze({ type: 'Failed', error });
}

export function isChatEvent(value) {
  return Boolean(value) && typeof value === 'object' &&
    (value.type === 'TextDelta' || value.type === 'Done' || value.type === 'Failed');
}
