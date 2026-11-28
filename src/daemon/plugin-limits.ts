// How much of something each plugin may do at once and in a minute, such as
// asking a model (`plugin-models.ts`) or adding to a project's media.

export class PluginLimits {
  readonly #running = new Map<string, number>();
  readonly #recent = new Map<string, number[]>();

  constructor(private readonly limits: { concurrent: number; perMinute: number; now?: () => number }) {}

  /**
   * Counts one toward `plugin`'s limits, or says which it reached. `release`
   * ends it; with `uncount`, as for one that did nothing, it no longer counts
   * toward the minute either.
   */
  take(plugin: string): { ok: true; release(options?: { uncount?: boolean }): void } | { ok: false; reached: "concurrent" | "perMinute" } {
    const now = this.limits.now?.() ?? Date.now();
    for (const [other, times] of this.#recent)
      if (other !== plugin && times.every((at) => now - at >= 60_000)) this.#recent.delete(other);
    const recent = (this.#recent.get(plugin) ?? []).filter((at) => now - at < 60_000);
    if ((this.#running.get(plugin) ?? 0) >= this.limits.concurrent) return { ok: false, reached: "concurrent" };
    if (recent.length >= this.limits.perMinute) return { ok: false, reached: "perMinute" };
    recent.push(now);
    this.#recent.set(plugin, recent);
    this.#running.set(plugin, (this.#running.get(plugin) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      release: (options) => {
        if (released) return;
        released = true;
        const left = (this.#running.get(plugin) ?? 1) - 1;
        if (left) this.#running.set(plugin, left);
        else this.#running.delete(plugin);
        if (options?.uncount) {
          const times = this.#recent.get(plugin);
          const index = times?.lastIndexOf(now) ?? -1;
          if (index >= 0) times!.splice(index, 1);
        }
      },
    };
  }
}
