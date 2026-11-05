import { watch, type FSWatcher } from "node:fs";
import type { PluginServices } from "./plugin-services.js";
import type { PluginSources } from "./plugin-sources.js";

// Plugins in development: each is added from a folder on this computer and
// added again, with what npm would publish from it, whenever a file there
// changes. A host running its native code restarts, so the new code runs, and
// its pages reload because its package digest is part of their address. Its
// approvals work as for any added plugin: more than was allowed waits.

/** Edits come in bursts, as an editor saves or a build writes. */
const SETTLE_MS = 300;
/** What a package manager or Git changes, which npm never publishes. */
const IGNORED = /^(?:node_modules|\.git)(?:[\\/]|$)/;

interface Watched {
  folder: string;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  /** The refresh running now, and whether another change came during it. */
  running?: Promise<void>;
  again?: boolean;
}

export class PluginDevelopment {
  readonly #watched = new Map<string, Watched>();
  readonly #errors = new Map<string, string>();
  #closed = false;
  #syncing: Promise<void> = Promise.resolve();

  constructor(
    private readonly services: PluginServices,
    private readonly sources: PluginSources,
    private readonly options: { settleMs?: number } = {},
  ) {}

  /** Why the plugin's folder couldn't be added the last time it changed, until it can. */
  error(id: string): string | undefined {
    return this.#errors.get(id);
  }

  /**
   * Watches the folder of each plugin in development and stops watching the
   * others, as after one is added or uninstalled. With `refresh`, as when the
   * app starts, each folder is added again first, for edits made meanwhile.
   */
  sync({ refresh = false }: { refresh?: boolean } = {}): Promise<void> {
    const run = this.#syncing.then(async () => {
      if (this.#closed) return;
      const folders = await this.sources.developmentFolders();
      for (const [id, watched] of this.#watched)
        if (folders.get(id) !== watched.folder) this.#stop(id);
      for (const [id] of this.#errors) if (!folders.has(id)) this.#errors.delete(id);
      for (const [id, folder] of folders) {
        if (this.#watched.has(id)) continue;
        this.#watch(id, folder);
        if (refresh) this.#schedule(id, 0);
      }
    });
    this.#syncing = run.catch(() => undefined);
    return run;
  }

  /** Waits for the refreshes running or waiting now, for tests and closing. */
  async settled(): Promise<void> {
    await this.#syncing;
    for (const watched of this.#watched.values()) {
      while (watched.timer || watched.running) {
        if (watched.running) await watched.running;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const id of [...this.#watched.keys()]) this.#stop(id);
    await this.#syncing;
  }

  #watch(id: string, folder: string): void {
    const watched: Watched = { folder };
    this.#watched.set(id, watched);
    try {
      const watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) => {
        if (name !== null && IGNORED.test(String(name))) return;
        this.#schedule(id);
      });
      watcher.on("error", () => {
        watcher.close();
        if (watched.watcher === watcher) watched.watcher = undefined;
        void this.#fail(id, `OhMyGame stopped seeing changes in ${folder}. Add the folder again to keep developing it.`);
      });
      watched.watcher = watcher;
    } catch {
      void this.#fail(id, `There is no folder at ${folder} to develop from. The last copy added stays.`);
    }
  }

  #stop(id: string): void {
    const watched = this.#watched.get(id);
    if (!watched) return;
    clearTimeout(watched.timer);
    watched.timer = undefined;
    watched.watcher?.close();
    this.#watched.delete(id);
  }

  #schedule(id: string, delay = this.options.settleMs ?? SETTLE_MS): void {
    const watched = this.#watched.get(id);
    if (!watched) return;
    if (watched.running) {
      watched.again = true;
      return;
    }
    clearTimeout(watched.timer);
    watched.timer = setTimeout(() => {
      watched.timer = undefined;
      watched.running = this.#refresh(id).finally(() => {
        watched.running = undefined;
        if (watched.again && this.#watched.get(id) === watched) {
          watched.again = false;
          this.#schedule(id);
        }
      });
    }, delay);
  }

  async #refresh(id: string): Promise<void> {
    try {
      const changed = await this.sources.refreshDevelopment(id);
      const hadError = this.#errors.delete(id);
      if (changed) await this.services.native.reload(id);
      // Adding notified everyone already; a cleared error needs saying too.
      else if (hadError) await this.services.changed();
    } catch (cause) {
      await this.#fail(id, cause instanceof Error ? cause.message : String(cause));
    }
  }

  async #fail(id: string, message: string): Promise<void> {
    if (this.#closed || this.#errors.get(id) === message) return;
    this.#errors.set(id, message);
    await this.services.changed().catch(() => undefined);
  }
}
