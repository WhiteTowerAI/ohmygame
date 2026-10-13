type DesktopSaveState = { closing: boolean; error?: string };

export class DesktopSaveCoordinator {
  #handlers = new Set<() => Promise<void>>();
  #listeners = new Set<() => void>();
  #saving?: Promise<void>;
  #state: DesktopSaveState = { closing: false };

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  register(handler: () => Promise<void>): () => void {
    this.#handlers.add(handler);
    return () => { this.#handlers.delete(handler); };
  }
  #publish(state: DesktopSaveState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  prepare(): Promise<void> {
    if (this.#state.closing && this.#saving) return this.#saving;
    this.#publish({ closing: true });
    // A cancelled attempt may still be finishing an import or save. Drain it,
    // then save the currently registered workspace on the next close attempt.
    const saving = (this.#saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      const results = await Promise.allSettled([...this.#handlers].map((handler) => Promise.resolve().then(handler)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }).finally(() => { if (this.#saving === saving) this.#saving = undefined; });
    this.#saving = saving;
    return saving;
  }
  cancel(error?: string): void { this.#publish({ closing: false, error }); }
}

export const desktopSave = new DesktopSaveCoordinator();
export const isDesktopClosing = () => desktopSave.getSnapshot().closing;
