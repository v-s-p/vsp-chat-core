export class CancelToken {
  #controller = new AbortController();

  get signal() {
    return this.#controller.signal;
  }

  get isCancelled() {
    return this.#controller.signal.aborted;
  }

  cancel() {
    this.#controller.abort();
  }
}
