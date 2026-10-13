/** Runs asynchronous work with a fixed upper bound and releases slots after failures. */
export class AsyncTaskPool {
  readonly #waiters: Array<{ start: () => void; cancel: () => void }> = [];
  #active = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("The task pool limit must be a positive integer");
    }
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          start: () => {
            signal?.removeEventListener("abort", waiter.cancel);
            resolve();
          },
          cancel: () => {
            const index = this.#waiters.indexOf(waiter);
            if (index >= 0) this.#waiters.splice(index, 1);
            reject(signal?.reason);
          },
        };
        signal?.addEventListener("abort", waiter.cancel, { once: true });
        this.#waiters.push(waiter);
      });
    } else {
      this.#active += 1;
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      const next = this.#waiters.shift();
      if (next) next.start();
      else this.#active -= 1;
    }
  }
}
