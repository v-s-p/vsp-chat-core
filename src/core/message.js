export const ROLES = Object.freeze(['system', 'user', 'assistant']);

export function createMessage({ role, content } = {}) {
  if (!ROLES.includes(role)) {
    throw new TypeError(`message role must be one of ${ROLES.join(', ')}`);
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new TypeError('message content must be a non-empty string');
  }
  return Object.freeze({ role, content });
}
