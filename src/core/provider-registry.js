import { ChatCoreError } from './chat-event.js';

export class ProviderRegistry {
  #providers = new Map();

  register(id, provider) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('provider id must be a non-empty string');
    }
    this.#providers.set(id, provider);
  }

  get(id) {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new ChatCoreError({
        code: 'unknown_provider',
        message: `no provider registered for id: ${id}`
      });
    }
    return provider;
  }
}
