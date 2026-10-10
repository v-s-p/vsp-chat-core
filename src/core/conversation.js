import { createMessage } from './message.js';

export class Conversation {
  #messages = [];

  addMessage(message) {
    const safe = createMessage(message);
    this.#messages.push(safe);
    return safe;
  }

  getMessages() {
    return Object.freeze([...this.#messages]);
  }
}
