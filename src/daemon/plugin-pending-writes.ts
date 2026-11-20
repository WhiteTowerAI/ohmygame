import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { mediaFileInfo } from "../shared/media-files.js";
import { writeAtomically } from "./checkpoint-objects.js";
import { checkPluginChange, PluginFileError, writablePath, type PluginFileEntry } from "./plugin-files.js";
import { WorkspaceError } from "./workspace.js";

// A panel's writes to its own folder of the project while an agent works in
// it. A plugin write outside a turn is refused then, so a turn's undo never
// takes back a panel's edit or the other way round; that leaves a panel
// unusable for as long as the agent works. Writes under the plugin's
// `projectFiles` wait here instead: the page reads them back at once, and
// once the project is idle they land as one change the person can undo.
//
// They are kept beside the project's other data until then, so quitting the
// app doesn't lose them, and they land when the project is next idle. What
// lands last wins: an agent's edit to the same file during its turn is
// replaced, and Undo brings it back.

/** How often waiting writes are tried while the project is busy. */
export const PENDING_RETRY_MS = 2_000;
/** How much one plugin may have waiting in a project. */
const PENDING_MAX_BYTES = 256 * 1024 * 1024;
const PENDING_MAX_OPERATIONS = 1_000;
const FILE = "pending.json";

type Operation =
  | { op: "write"; path: string; blob: string; size: number; at: string }
  | { op: "delete"; path: string; at: string };

interface Waiting {
  project: ProjectState;
  plugin: string;
  operations: Operation[];
}

export interface PluginPendingWritesOptions {
  /** The projects whose waiting writes are kept, looked up again before they land. */
  projects(): ProjectState[];
  project(id: string): ProjectState | undefined;
  /** Whether a plugin write would be refused now. */
  busy(project: ProjectState): boolean;
  /** Whether the plugin may still write to the project's files, checked before what it left lands. */
  allowed(project: ProjectState, plugin: string): Promise<boolean>;
  /**
   * Runs `apply` as one undoable plugin change. `apply` doesn't run when the
   * change is refused before it starts, such as when the project became busy.
   */
  run(project: ProjectState, plugin: string, title: string, apply: () => Promise<void>): Promise<void>;
  /** Applies one waiting write or delete to the project's files. */
  write(project: ProjectState, file: string, contents: Buffer): Promise<void>;
  remove(project: ProjectState, file: string): Promise<void>;
  warn(error: unknown, message: string): void;
}

/** The project paths a manifest's `projectFiles` names, without `./` or a trailing `/`. */
export function ownedFolders(projectFiles: readonly string[] | undefined): string[] {
  return (projectFiles ?? []).map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
}

/** Whether a page's path is one of `owned` or inside one. */
export function isOwned(file: string, owned: readonly string[]): boolean {
  return owned.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

const under = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);

/** Thrown by a stage once the project is idle again, so the change is made the usual way instead. */
export class ProjectIdle extends Error {
  constructor() {
    super("The project is idle");
  }
}

/** File system errors worth another try, such as a file another program has open on Windows. */
const PASSING = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE", "ENFILE"]);
/** How many times a write that failed that way is tried before it's given up. */
const PENDING_ATTEMPTS = 5;

/** Why one waiting change failed, naming no path on the computer, as plugin history reaches pages. */
function reason(cause: unknown): string {
  if (cause instanceof PluginFileError || cause instanceof WorkspaceError) return cause.message;
  const { code } = cause as NodeJS.ErrnoException;
  return code ? `the file system refused it (${code})` : "it failed";
}

export class PluginPendingWrites {
  readonly #waiting = new Map<string, Waiting>();
  /** Plugins whose waiting list couldn't be read: it's left as it is, and they can't add to it. */
  readonly #unreadable = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Failed attempts at a waiting write, by its blob or path. */
  readonly #attempts = new Map<string, number>();
  #timer?: NodeJS.Timeout;
  #started!: () => void;
  /** Settles once plugins are known, so a plugin's access can be checked before what it left lands. */
  readonly #ready = new Promise<void>((resolve) => { this.#started = resolve; });

  constructor(private readonly options: PluginPendingWritesOptions) {}

  /** Reads what was left waiting when the app last stopped. Runs before pages can reach the project. */
  async load(): Promise<void> {
    for (const project of this.options.projects()) {
      const root = path.join(storage(project), "plugin-pending");
      for (const publisher of await readdir(root).catch(() => [])) {
        for (const name of await readdir(path.join(root, publisher)).catch(() => [])) {
          const plugin = `${publisher}/${name}`;
          try {
            const operations = await this.#load(project, plugin);
            if (operations.length) this.#waiting.set(key(project.id, plugin), { project, plugin, operations });
          } catch (error) {
            this.#unreadable.add(key(project.id, plugin));
            this.options.warn(error, `Could not read ${plugin}'s waiting writes`);
          }
        }
      }
    }
  }

  /** Lands what waits once plugins are known, and keeps trying while projects are busy. */
  start(): void {
    this.#started();
    this.#timer = setInterval(() => void this.#flushAll(), PENDING_RETRY_MS);
    this.#timer.unref();
    void this.#flushAll();
  }

  stop() {
    clearInterval(this.#timer);
  }

  has(project: ProjectState, plugin: string): boolean {
    return !!this.#waiting.get(key(project.id, plugin))?.operations.length;
  }

  /** Keeps a page's write until the project is idle; `ProjectIdle` when it already is. */
  stageWrite(project: ProjectState, plugin: string, requested: string, contents: Buffer): Promise<string> {
    return this.#staging(project, plugin, async (waiting) => {
      // Refused now rather than when it lands, where only the history would say.
      const { path: file } = await checkPluginChange(project.workspacePath, requested, "write");
      const kept = waiting.operations.filter((operation) => operation.op !== "write" || operation.path !== file);
      const bytes = kept.reduce((sum, operation) => sum + (operation.op === "write" ? operation.size : 0), 0);
      if (bytes + contents.length > PENDING_MAX_BYTES || kept.length >= PENDING_MAX_OPERATIONS)
        throw new PluginFileError("Too much is waiting for the agent to finish. Try again once it has.", 409);
      const blob = `${randomUUID()}.bin`;
      const folder = this.#folder(project, plugin);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, blob), contents, { flag: "wx" });
      await this.#save(project, plugin, waiting, [...kept, { op: "write", path: file, blob, size: contents.length, at: new Date().toISOString() }]);
      return file;
    });
  }

  /** Keeps a page's delete until the project is idle; `ProjectIdle` when it already is. */
  stageDelete(project: ProjectState, plugin: string, requested: string): Promise<void> {
    return this.#staging(project, plugin, async (waiting) => {
      const { path: file, exists: onDisk } = await checkPluginChange(project.workspacePath, requested, "delete");
      const shown = this.#read(waiting, file) !== undefined || waiting.operations.some((operation) => operation.op === "write" && under(operation.path, file));
      if (this.#deleted(waiting, file) || (!onDisk && !shown)) throw new WorkspaceError("File not found", "ENOENT");
      // What waits inside it is gone with it, and needs no delete of its own unless the disk has it.
      const kept = waiting.operations.filter((operation) => !under(operation.path, file));
      await this.#save(project, plugin, waiting, onDisk ? [...kept, { op: "delete", path: file, at: new Date().toISOString() }] : kept);
    });
  }

  /**
   * Makes what a plugin left waiting now, without a change of its own, before
   * one of its panel's tools changes files for whoever called it: what the
   * panel does during the call is the caller's, and what it did before comes
   * first.
   */
  land(project: ProjectState, plugin: string): Promise<void> {
    if (!this.has(project, plugin)) return Promise.resolve();
    return this.#locked(project, plugin, async () => {
      const waiting = this.#waiting.get(key(project.id, plugin));
      if (!waiting?.operations.length) return;
      const operations = waiting.operations;
      const { failed, again } = await this.#apply(project, plugin, operations);
      if (failed.length) this.options.warn(undefined, `Some of ${plugin}'s waiting writes failed: ${failed.join("; ")}`);
      await this.#save(project, plugin, waiting, [...again, ...waiting.operations.slice(operations.length)]);
    });
  }

  /** A file as the page last left it, `deleted`, or undefined when nothing waits for it. */
  async read(project: ProjectState, plugin: string, requested: string): Promise<{ size: number; contentType: string; stream(): NodeJS.ReadableStream } | "deleted" | undefined> {
    const waiting = this.#waiting.get(key(project.id, plugin));
    if (!waiting) return undefined;
    const file = requested.replaceAll("\\", "/");
    const found = this.#read(waiting, file);
    if (found === undefined) return this.#deleted(waiting, file) ? "deleted" : undefined;
    let handle;
    try {
      handle = await open(path.join(this.#folder(project, plugin), found.blob), "r");
    } catch (cause) {
      // It landed meanwhile, and the project has it now.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
    const opened = handle;
    const size = await opened.stat().then((stats) => stats.size, async (cause) => { await opened.close(); throw cause; });
    return {
      size,
      contentType: mediaFileInfo(file)?.contentType ?? "application/octet-stream",
      stream: () => opened.createReadStream(),
    };
  }

  /** A listing of the project's files with what waits applied to it. */
  list(
    project: ProjectState,
    plugin: string,
    listed: { entries: PluginFileEntry[]; truncated: boolean },
    { folder = "", recursive = false }: { folder?: string; recursive?: boolean },
  ): { entries: PluginFileEntry[]; truncated: boolean } {
    const waiting = this.#waiting.get(key(project.id, plugin));
    if (!waiting) return listed;
    const start = folder.replaceAll("\\", "/").replace(/\/+$/, "");
    const shows = (file: string) => {
      if (start && !file.startsWith(`${start}/`)) return false;
      return recursive || !file.slice(start ? start.length + 1 : 0).includes("/");
    };
    const entries = new Map(listed.entries.map((entry) => [entry.path, entry]));
    for (const operation of waiting.operations) {
      if (operation.op === "delete") {
        for (const file of entries.keys()) if (under(file, operation.path)) entries.delete(file);
        continue;
      }
      const parts = operation.path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const folderPath = parts.slice(0, depth).join("/");
        if (shows(folderPath) && !entries.has(folderPath)) entries.set(folderPath, { path: folderPath, kind: "folder", modified: operation.at });
      }
      if (!shows(operation.path)) continue;
      const mediaType = mediaFileInfo(operation.path)?.contentType;
      entries.set(operation.path, { path: operation.path, kind: "file", size: operation.size, modified: operation.at, ...(mediaType ? { mediaType } : {}) });
    }
    return { entries: [...entries.values()], truncated: listed.truncated };
  }

  /** Lands what waits in every idle project. */
  async #flushAll(): Promise<void> {
    await Promise.all([...this.#waiting.values()].map(({ project, plugin }) =>
      this.flush(project, plugin).catch((error) => this.options.warn(error, `Could not land ${plugin}'s waiting writes`))));
  }

  /**
   * Lands what a plugin left waiting as one undoable change, when the project
   * is idle. What can't land yet stays for the next try.
   */
  async flush(project: ProjectState, plugin: string): Promise<void> {
    if (!this.has(project, plugin)) return;
    await this.#ready;
    return this.#locked(project, plugin, async () => {
      const waiting = this.#waiting.get(key(project.id, plugin));
      if (!waiting?.operations.length) return;
      const current = this.options.project(project.id);
      // The project is gone, and its data with it.
      if (!current) {
        this.#waiting.delete(key(project.id, plugin));
        return;
      }
      if (this.options.busy(current)) return;
      const operations = waiting.operations;
      if (!(await this.options.allowed(current, plugin))) {
        this.options.warn(undefined, `${plugin} can't write to the project any more, so its waiting writes were dropped`);
        await this.#save(current, plugin, waiting, []);
        return;
      }
      let applied: { failed: string[]; again: Operation[] } | undefined;
      try {
        await this.options.run(current, plugin, title(operations), async () => {
          applied = await this.#apply(current, plugin, operations);
          if (applied.failed.length) throw new Error(`Some of what the panel saved during the agent's turn couldn't be written. ${applied.failed.join("; ")}`);
        });
      } catch (error) {
        // Refused before it started, such as when the agent started again: tried later.
        if (!applied) return;
        // What ran is recorded as a change that failed, and stays as it left the files.
        this.options.warn(error, `Some of ${plugin}'s waiting writes failed`);
      }
      await this.#save(current, plugin, waiting, [...applied!.again, ...waiting.operations.slice(operations.length)]);
    });
  }

  /** Makes waiting changes in order: what failed for good, and what to try again. */
  async #apply(project: ProjectState, plugin: string, operations: Operation[]): Promise<{ failed: string[]; again: Operation[] }> {
    const failed: string[] = [];
    const again: Operation[] = [];
    for (const operation of operations) {
      const id = operation.op === "write" ? operation.blob : `${operation.at}\0${operation.path}`;
      try {
        if (operation.op === "write") await this.options.write(project, operation.path, await readFile(path.join(this.#folder(project, plugin), operation.blob)));
        else await this.options.remove(project, operation.path);
        this.#attempts.delete(id);
      } catch (cause) {
        // Someone else removed it meanwhile.
        if (operation.op === "delete" && cause instanceof WorkspaceError && cause.code === "ENOENT") continue;
        const attempts = (this.#attempts.get(id) ?? 0) + 1;
        const code = (cause as NodeJS.ErrnoException).code;
        if (code && PASSING.has(code) && attempts < PENDING_ATTEMPTS) {
          this.#attempts.set(id, attempts);
          again.push(operation);
          continue;
        }
        this.#attempts.delete(id);
        failed.push(`${operation.path}: ${reason(cause)}`);
      }
    }
    return { failed, again };
  }

  /** Runs a stage under the plugin's lock, once it's sure the project is still busy and its list can be added to. */
  #staging<T>(project: ProjectState, plugin: string, stage: (waiting: Waiting) => Promise<T>): Promise<T> {
    return this.#locked(project, plugin, async () => {
      if (this.#unreadable.has(key(project.id, plugin)))
        throw new PluginFileError("What this plugin saved during an earlier agent turn can't be read, so it can't save more until the agent is done.", 409);
      // The agent finished meanwhile: what lands now would otherwise come after a change made since.
      if (!this.options.busy(project)) throw new ProjectIdle();
      return stage(this.#entry(project, plugin));
    });
  }

  #entry(project: ProjectState, plugin: string): Waiting {
    const id = key(project.id, plugin);
    let waiting = this.#waiting.get(id);
    if (!waiting) this.#waiting.set(id, (waiting = { project, plugin, operations: [] }));
    waiting.project = project;
    return waiting;
  }

  /** The newest waiting write of `file`, unless a delete of it or a folder holding it came after. */
  #read(waiting: Waiting, file: string) {
    for (let index = waiting.operations.length - 1; index >= 0; index--) {
      const operation = waiting.operations[index]!;
      if (operation.op === "write" && operation.path === file) return operation;
      if (operation.op === "delete" && under(file, operation.path)) return undefined;
    }
    return undefined;
  }

  #deleted(waiting: Waiting, file: string): boolean {
    for (let index = waiting.operations.length - 1; index >= 0; index--) {
      const operation = waiting.operations[index]!;
      if (operation.op === "write" && operation.path === file) return false;
      if (operation.op === "delete" && under(file, operation.path)) return true;
    }
    return false;
  }

  #folder(project: ProjectState, plugin: string) {
    return path.join(storage(project), "plugin-pending", ...plugin.split("/"));
  }

  async #load(project: ProjectState, plugin: string): Promise<Operation[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.#folder(project, plugin), FILE), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    const value = JSON.parse(text) as { version?: unknown; operations?: unknown };
    if (value.version !== 1 || !Array.isArray(value.operations)) throw new Error(`${FILE} isn't one this version of OhMyGame can read`);
    const operations = value.operations as Operation[];
    for (const operation of operations) {
      writablePath(operation.path);
      if (operation.op === "write") {
        if (!/^[0-9a-f-]+\.bin$/.test(operation.blob)) throw new Error(`${FILE} names a file it can't hold`);
        await lstat(path.join(this.#folder(project, plugin), operation.blob));
      } else if (operation.op !== "delete") throw new Error(`${FILE} holds an operation this version of OhMyGame can't run`);
    }
    return operations;
  }

  /** Keeps `operations` and removes what no longer waits; the caller holds the plugin's lock. */
  async #save(project: ProjectState, plugin: string, waiting: Waiting, operations: Operation[]) {
    const folder = this.#folder(project, plugin);
    if (!operations.length) {
      await rm(folder, { recursive: true, force: true });
      waiting.operations = [];
      this.#waiting.delete(key(project.id, plugin));
      return;
    }
    await mkdir(folder, { recursive: true });
    await writeAtomically(folder, path.join(folder, FILE), `${JSON.stringify({ version: 1, operations }, null, 2)}\n`);
    const blobs = new Set(operations.flatMap((operation) => operation.op === "write" ? [operation.blob] : []));
    for (const operation of waiting.operations)
      if (operation.op === "write" && !blobs.has(operation.blob)) await rm(path.join(folder, operation.blob), { force: true });
    waiting.operations = operations;
  }

  #locked<T>(project: ProjectState, plugin: string, work: () => Promise<T>): Promise<T> {
    const id = key(project.id, plugin);
    const result = (this.#locks.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = result.catch(() => {});
    this.#locks.set(id, tail);
    void tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    });
    return result;
  }
}

const key = (projectId: string, plugin: string) => `${projectId}\0${plugin}`;
const storage = (project: ProjectState) => project.storagePath ?? path.join(project.workspacePath, ".data");

function title(operations: Operation[]): string {
  if (operations.length === 1) return `${operations[0]!.op === "write" ? "Write" : "Delete"} ${operations[0]!.path}`;
  return `Save ${operations.length} changes made during the agent's turn`;
}
