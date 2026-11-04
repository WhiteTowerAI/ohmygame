import { watch, type FSWatcher } from "node:fs";
import { HOOK_FILES_MAX } from "../shared/plugin-hooks.js";

// Watches project folders for plugins that want to know when files change:
// a native `files.changed` hook, or a page that reads the project's files.
// Changes within `DEBOUNCE_MS` of each other are sent together.

const DEBOUNCE_MS = 500;
/** Folders whose changes no plugin hears about: tools' own state, and dependencies. */
const IGNORED = new Set([".git", "node_modules", ".data", ".ohmygame"]);

export type FileChangeListener = (folder: string, change: { paths: string[]; truncated?: boolean }) => void;

/** A changed path as plugins see it, or undefined for one they don't hear about. */
export function watchedPath(name: string): string | undefined {
  const path = name.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!path || path.split("/").some((segment) => IGNORED.has(segment))) return undefined;
  return path;
}

interface Watch {
  watcher: FSWatcher;
  pending: Set<string>;
  /** Some change came without a name, or more changed than one event carries. */
  overflow: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class ProjectFileWatches {
  readonly #watches = new Map<string, Watch>();
  readonly #listener: FileChangeListener;
  readonly #debounceMs: number;

  constructor(listener: FileChangeListener, options: { debounceMs?: number } = {}) {
    this.#listener = listener;
    this.#debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  watching(folder: string): boolean {
    return this.#watches.has(folder);
  }

  /** Starts or stops watching `folder`. */
  set(folder: string, on: boolean): void {
    if (!on) {
      this.close(folder);
      return;
    }
    if (this.#watches.has(folder)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) => this.#changed(folder, watcher, name));
    } catch {
      // A folder that can't be watched still works; plugins just don't hear about its files.
      return;
    }
    watcher.on("error", () => {
      if (this.#watches.get(folder)?.watcher === watcher) this.close(folder);
    });
    this.#watches.set(folder, { watcher, pending: new Set(), overflow: false });
  }

  close(folder: string): void {
    const watched = this.#watches.get(folder);
    if (!watched) return;
    clearTimeout(watched.timer);
    watched.watcher.close();
    this.#watches.delete(folder);
  }

  dispose(): void {
    for (const folder of [...this.#watches.keys()]) this.close(folder);
  }

  #changed(folder: string, watcher: FSWatcher, name: string | Buffer | null) {
    const watched = this.#watches.get(folder);
    if (watched?.watcher !== watcher) return;
    if (name === null) watched.overflow = true;
    else {
      const path = watchedPath(String(name));
      if (!path) return;
      if (watched.pending.size < HOOK_FILES_MAX) watched.pending.add(path);
      else if (!watched.pending.has(path)) watched.overflow = true;
    }
    watched.timer ??= setTimeout(() => {
      watched.timer = undefined;
      const paths = [...watched.pending].sort();
      const truncated = watched.overflow;
      watched.pending.clear();
      watched.overflow = false;
      if (this.#watches.get(folder) !== watched) return;
      try {
        this.#listener(folder, { paths, ...(truncated ? { truncated } : {}) });
      } catch {
        // A listener that fails doesn't stop the watch.
      }
    }, this.#debounceMs);
    watched.timer.unref?.();
  }
}
