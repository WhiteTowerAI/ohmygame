import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where a project's checkpoints are, when they are not in its storage: Settings
 * → General → Checkpoint location names a folder, and each project's store is
 * a folder in it named after the project's id.
 *
 * Each project records the store it uses in its own storage, so moving the
 * stores one by one never leaves a project unsure where its history is. A
 * project without that record uses `checkpoints/` in its storage, as before
 * the setting existed.
 */

/** In a project's storage: the folder of its store, when that is not `checkpoints/` beside it. */
export const POINTER_FILE = "checkpoints-location.json";
/** In a project's storage while its store moves, and until the old one is gone. */
export const MOVE_FILE = "checkpoints-move.json";
/** In the chosen folder: says that it holds checkpoint stores. */
export const ROOT_MARKER = "ohmygame-checkpoints-root.json";
/** In each store made or moved by OhMyGame: which project it belongs to. */
export const STORE_MARKER = "ohmygame-checkpoints.json";

/** The folder that holds a project's own files: its store and pointer are found from it. */
export function projectStorage(project: { workspacePath: string; storagePath?: string }): string {
  return project.storagePath ?? path.dirname(project.workspacePath);
}

/** The store a project has in its own storage. */
export function defaultStore(project: { workspacePath: string; storagePath?: string }): string {
  return path.join(projectStorage(project), "checkpoints");
}

/** A project's id, which names its store in the chosen folder. */
export function projectId(project: { id?: string; workspacePath: string; storagePath?: string }): string {
  return project.id ?? path.basename(projectStorage(project));
}

/** The store's folder is not there, for example because the disk it is on is not connected. */
export class CheckpointLocationUnavailableError extends Error {
  constructor(readonly folder: string) {
    super(`The checkpoint folder ${folder} is not available. Connect its disk, or choose another checkpoint location in Settings → General.`);
  }
}

/** The project's record of where its store is cannot be read, so no store is used rather than a new, empty one. */
export class CheckpointPointerError extends Error {
  constructor(file: string) {
    super(`The checkpoint location record ${file} cannot be read. Fix or remove it to use the project's file history.`);
  }
}

/**
 * The store the project's record names, or undefined when it has none and
 * so uses `checkpoints/` in its storage.
 */
export async function readPointer(storage: string): Promise<string | undefined> {
  const file = path.join(storage, POINTER_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CheckpointPointerError(file);
  }
  try {
    const record = JSON.parse(text) as { version?: unknown; path?: unknown };
    if (record.version === 1 && typeof record.path === "string" && path.isAbsolute(record.path)) return record.path;
  } catch {
    // Reported below.
  }
  throw new CheckpointPointerError(file);
}

/** Records the store a project uses. The default store is recorded by having no record. */
export async function writePointer(storage: string, store: string): Promise<void> {
  const file = path.join(storage, POINTER_FILE);
  if (samePath(store, path.join(storage, "checkpoints"))) {
    await rm(file, { force: true });
    return;
  }
  await writeJsonAtomically(file, { version: 1, path: store });
}

export interface StoreMove {
  from: string;
  to: string;
}

/** The move under way, or left unfinished by an earlier run of the app. */
export async function readMove(storage: string): Promise<StoreMove | undefined> {
  try {
    const record = JSON.parse(await readFile(path.join(storage, MOVE_FILE), "utf8")) as Record<string, unknown>;
    if (record.version === 1 && typeof record.from === "string" && typeof record.to === "string") return { from: record.from, to: record.to };
  } catch {
    // A record that is not there or cannot be read moves nothing.
  }
  return undefined;
}

export async function writeMove(storage: string, move: StoreMove): Promise<void> {
  await writeJsonAtomically(path.join(storage, MOVE_FILE), { version: 1, ...move });
}

export async function removeMove(storage: string): Promise<void> {
  await rm(path.join(storage, MOVE_FILE), { force: true });
}

/** The project a store says it belongs to, or undefined when it says none. */
export async function storeOwner(store: string): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(path.join(store, STORE_MARKER), "utf8")) as { projectId?: unknown };
    return typeof record.projectId === "string" ? record.projectId : undefined;
  } catch {
    return undefined;
  }
}

export async function markStore(store: string, id: string): Promise<void> {
  await writeJsonAtomically(path.join(store, STORE_MARKER), { version: 1, projectId: id });
}

/** Whether the folder is there and says it holds checkpoint stores. */
export async function rootAvailable(root: string): Promise<boolean> {
  return (await lstat(path.join(root, ROOT_MARKER)).catch(() => undefined))?.isFile() === true;
}

/**
 * Whether OhMyGame may remove a store that is not in use: one in the
 * project's own storage, or one that says it is the project's.
 */
export async function ownStore(store: string, project: { id?: string; workspacePath: string; storagePath?: string }): Promise<boolean> {
  if (samePath(store, defaultStore(project))) return true;
  return (await storeOwner(store)) === projectId(project);
}

/** Removes a folder, trying again while another program, such as a virus scanner on Windows, holds a file in it. */
export async function removeFolder(folder: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** A checkpoint location that cannot be used. The message says why. */
export class CheckpointLocationError extends Error {}

/**
 * Settings → General → Checkpoint location: the folder that holds every
 * project's checkpoints. Unset, each project keeps them in its own storage.
 */
export class CheckpointLocationSettings {
  #location?: string;
  #problem?: string;
  #loaded?: Promise<void>;
  #queue = Promise.resolve();
  readonly #file: string;

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, "checkpoint-location.json");
  }

  async get(): Promise<{ location?: string; problem?: string }> {
    await (this.#loaded ??= this.#load());
    return {
      ...(this.#location ? { location: this.#location } : {}),
      ...(this.#problem ? { problem: this.#problem } : {}),
    };
  }

  /**
   * Chooses the folder, after `check` accepts it, or goes back to each
   * project's own storage. The folder is marked as holding checkpoint stores.
   */
  set(location: string | undefined, check: (folder: string) => Promise<void> = async () => {}): Promise<{ location?: string }> {
    const run = this.#queue.then(async () => {
      await this.get();
      if (this.#problem) throw new CheckpointLocationError(this.#problem);
      const next = location === undefined ? undefined : await validateFolder(location);
      if (next) {
        await check(next);
        // Writing the mark is also the test that the folder can be written to.
        const marker = path.join(next, ROOT_MARKER);
        if (!(await rootAvailable(next)))
          await writeJsonAtomically(marker, { version: 1 }).catch(() => {
            throw new CheckpointLocationError("The checkpoint location cannot be written to");
          });
      }
      await mkdir(path.dirname(this.#file), { recursive: true });
      await writeJsonAtomically(this.#file, { version: 1, ...(next ? { location: next } : {}) });
      this.#location = next;
      return next ? { location: next } : {};
    });
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  async #load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.#file, "utf8")) as Record<string, unknown>;
      if (stored.version !== 1 || (stored.location !== undefined && (typeof stored.location !== "string" || !path.isAbsolute(stored.location))))
        throw new Error("Unsupported settings");
      this.#location = stored.location as string | undefined;
    } catch (cause) {
      // Settings that cannot be read move nothing, and are left as they are.
      this.#location = undefined;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        this.#problem = "Checkpoint location settings cannot be read. Fix or remove checkpoint-location.json before changing them.";
    }
  }
}

async function validateFolder(location: string): Promise<string> {
  if (!path.isAbsolute(location)) throw new CheckpointLocationError("The checkpoint location must be an absolute path");
  let resolved: string;
  try {
    if (!(await lstat(location)).isDirectory()) throw new Error("not a directory");
    resolved = await realpath(location);
  } catch {
    throw new CheckpointLocationError("The checkpoint location is not an available folder");
  }
  if (path.parse(resolved).root === resolved) throw new CheckpointLocationError("The filesystem root cannot be the checkpoint location");
  return resolved;
}

/** The bytes free for this process on the disk that holds a folder, or undefined where that cannot be told. */
export async function freeBytes(folder: string): Promise<number | undefined> {
  try {
    const stats = await statfs(folder);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}
