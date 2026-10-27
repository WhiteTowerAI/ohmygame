import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const OPENROUTER_REFRESH_INTERVAL_MS = 4 * 60 * 60_000;
const CHECK_INTERVAL_MS = 60_000;
export const MODEL_CATALOG_REFRESH_ERROR =
  "Model catalog refresh failed. Existing models are still available.";
const REFRESH_TIMEOUT_MS = 15_000;

/** Coordinates Pi's cached catalogs without making a model-list request wait for the network. */
export class ModelCatalogRefresh {
  #pending = new Map<
    string,
    { controller: AbortController; force: boolean; promise: Promise<void> }
  >();
  #nextRefresh = new Map<string, number>();
  #closed = false;

  constructor(private readonly enabled: (provider: string) => boolean) {}

  canRefresh(runtime: ModelRuntime, provider: string): boolean {
    return (
      !this.#closed &&
      process.env.PI_OFFLINE === undefined &&
      this.enabled(provider) &&
      !!runtime.getProvider(provider)?.refreshModels &&
      runtime.hasConfiguredAuth(provider)
    );
  }

  schedule(runtime: ModelRuntime, providers?: readonly string[]): string[] {
    if (this.#closed || process.env.PI_OFFLINE !== undefined) return [];
    for (const provider of providers ??
      runtime.getProviders().map((entry) => entry.id)) {
      void this.refresh(runtime, provider).catch(() => {});
    }
    return [...this.#pending.keys()];
  }

  refreshing(provider: string): boolean {
    return this.#pending.has(provider);
  }

  refresh(
    runtime: ModelRuntime,
    provider: string,
    force = false,
  ): Promise<void> {
    if (!this.canRefresh(runtime, provider)) return Promise.resolve();
    const pending = this.#pending.get(provider);
    if (pending) {
      // A manual request must not be satisfied by a cache-only automatic check.
      return force && !pending.force
        ? pending.promise
            .catch(() => {})
            .then(() => this.refresh(runtime, provider, true))
        : pending.promise;
    }
    if (!force && Date.now() < (this.#nextRefresh.get(provider) ?? 0))
      return Promise.resolve();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    ]);
    const task = { controller, force, promise: Promise.resolve() };
    task.promise = Promise.resolve()
      .then(async () => {
        const result = await runtime.refresh({
          allowNetwork: true,
          providers: [provider],
          force,
          signal,
        });
        if (result.aborted || result.errors.size)
          throw new Error(MODEL_CATALOG_REFRESH_ERROR);
        if (this.#pending.get(provider) === task) {
          // Pi owns ordinary providers' persisted four-hour cache. OpenRouter's
          // personalized catalog has no SDK throttle, so limit it here.
          const interval =
            provider === "openrouter"
              ? OPENROUTER_REFRESH_INTERVAL_MS
              : CHECK_INTERVAL_MS;
          this.#nextRefresh.set(provider, Date.now() + interval);
        }
      })
      .catch(() => {
        if (this.#pending.get(provider) === task)
          this.#nextRefresh.set(provider, Date.now() + CHECK_INTERVAL_MS);
        // Provider errors may contain connection details. Only return a fixed public message.
        throw new Error(MODEL_CATALOG_REFRESH_ERROR);
      })
      .finally(() => {
        if (this.#pending.get(provider) === task)
          this.#pending.delete(provider);
      });
    this.#pending.set(provider, task);
    return task.promise;
  }

  invalidate(provider: string): void {
    this.#pending.get(provider)?.controller.abort();
    this.#pending.delete(provider);
    this.#nextRefresh.delete(provider);
  }

  close(): void {
    this.#closed = true;
    for (const { controller } of this.#pending.values()) controller.abort();
    this.#pending.clear();
  }
}
