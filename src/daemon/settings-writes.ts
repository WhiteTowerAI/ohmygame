import { AsyncLocalStorage } from "node:async_hooks";

interface Owner {
  active: boolean;
  stores: Set<object>;
  children: Set<Promise<unknown>>;
}

/** One daemon's settings owner. This does not lock other processes or synchronous readers. */
export class SettingsWrites {
  #pending: Promise<unknown> = Promise.resolve();
  #context = new AsyncLocalStorage<Owner>();

  /**
   * Load and mutate under the same owner, in invocation order. A store's callback
   * may await another store (removing a provider also clears its credentials).
   * Re-entering an active store is a programming error, not a second writer.
   */
  run<T>(store: object, operation: () => Promise<T>): Promise<T> {
    const current = this.#context.getStore();
    if (current?.active) return this.#enter(current, store, operation);
    const next = this.#pending.then(async () => {
      const owner: Owner = {
        active: true,
        stores: new Set(),
        children: new Set(),
      };
      return this.#context.run(owner, async () => {
        try {
          return await this.#enter(owner, store, operation);
        } finally {
          // Even an early callback failure must not release a running nested write.
          while (owner.children.size)
            await Promise.allSettled([...owner.children]);
          owner.active = false;
        }
      });
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  #enter<T>(
    owner: Owner,
    store: object,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (owner.stores.has(store))
      return Promise.reject(
        new Error("Settings store is already active in this operation"),
      );
    owner.stores.add(store);
    const pending = Promise.resolve()
      .then(operation)
      .finally(() => {
        owner.stores.delete(store);
        owner.children.delete(pending);
      });
    owner.children.add(pending);
    return pending;
  }
}
