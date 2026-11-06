import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectCoverMode, ProjectCoverState } from "../shared/contracts.js";
import { AUTOMATIC_COVER_FILE } from "../shared/project-layout.js";

/** The largest cover a project accepts, uploaded or imported. */
export const MAX_PROJECT_COVER_BYTES = 5 * 1024 * 1024;

// Names in a project's `.ohmygame/` folder. The automatic cover is captured on
// this computer and is captured again elsewhere, so it stays in `local/`.
const CUSTOM_COVER = "cover.webp";
const AUTOMATIC_COVER = path.join(...AUTOMATIC_COVER_FILE.split("/").slice(1));
const FROZEN_COVER = "cover-frozen.webp";
const COVER_STATE = "cover-state.json";
const LOGO = "logo.webp";

/** The largest logo a project accepts. */
export const MAX_PROJECT_LOGO_BYTES = 1024 * 1024;

/**
 * Cover operations share a queue so a late automatic capture cannot overwrite a custom cover. Each takes the
 * project's `.ohmygame/` folder.
 */
export class ProjectCovers {
  readonly #operations = new Map<string, Promise<unknown>>();

  state(directory: string): Promise<ProjectCoverState> {
    return this.#serial(directory, async () => ({ mode: await coverMode(directory) }));
  }

  read(directory: string): Promise<Buffer | undefined> {
    return this.#serial(directory, async () => {
      if (await coverMode(directory) === "auto") return readOptional(path.join(directory, AUTOMATIC_COVER));
      return (await readOptional(path.join(directory, CUSTOM_COVER))) ?? readOptional(path.join(directory, FROZEN_COVER));
    });
  }

  set(directory: string, contents: Uint8Array, source: ProjectCoverMode): Promise<void> {
    return this.#serial(directory, async () => {
      if (source === "auto" && await coverMode(directory) === "custom") return;
      await replaceFile(directory, source === "custom" ? CUSTOM_COVER : AUTOMATIC_COVER, contents);
      if (source === "custom") {
        await replaceFile(directory, COVER_STATE, Buffer.from(`${JSON.stringify({ mode: source })}\n`));
        await removeFile(directory, FROZEN_COVER);
      }
    });
  }

  setMode(directory: string, mode: ProjectCoverMode, fallback?: Uint8Array): Promise<void> {
    return this.#serial(directory, async () => {
      if (await coverMode(directory) === mode) return;
      if (mode === "auto") {
        await removeFile(directory, FROZEN_COVER);
      } else if (!await hasCustomCover(directory)) {
        const current = await readOptional(path.join(directory, AUTOMATIC_COVER)) ?? fallback;
        if (current) await replaceFile(directory, FROZEN_COVER, current);
      }
      await replaceFile(directory, COVER_STATE, Buffer.from(`${JSON.stringify({ mode })}\n`));
    });
  }

  readLogo(directory: string): Promise<Buffer | undefined> {
    return this.#serial(directory, () => readOptional(path.join(directory, LOGO)));
  }

  setLogo(directory: string, contents: Uint8Array | undefined): Promise<void> {
    return this.#serial(directory, async () => {
      if (contents) await replaceFile(directory, LOGO, contents);
      else await removeFile(directory, LOGO);
    });
  }

  /**
   * Moves the covers and logo an older OhMyGame kept in the project's own
   * storage into `directory`, without replacing any already there.
   */
  // compat: since beta.5.5, remove from beta.7 and 2026-12-06. Covers and logos were kept beside project.json.
  migrate(storage: string, directory: string): Promise<void> {
    return this.#serial(directory, async () => {
      for (const file of [CUSTOM_COVER, AUTOMATIC_COVER, FROZEN_COVER, COVER_STATE, LOGO]) {
        const source = path.join(storage, path.basename(file));
        if (!(await exists(source))) continue;
        await ensureFolders(directory, file);
        // A copy, since the workspace can be on another drive than the storage. One already in the folder is kept,
        // and so is the old copy then.
        try {
          await copyFile(source, path.join(directory, file), constants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        await rm(source, { force: true });
      }
    });
  }

  async #serial<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(directory) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.#operations.set(directory, next);
    try {
      return await next;
    } finally {
      if (this.#operations.get(directory) === next) this.#operations.delete(directory);
    }
  }
}

async function coverMode(directory: string): Promise<ProjectCoverMode> {
  const state = await readOptional(path.join(directory, COVER_STATE));
  if (state) {
    try {
      const mode = JSON.parse(state.toString())?.mode;
      if (mode === "auto" || mode === "custom") return mode;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return await hasCustomCover(directory) ? "custom" : "auto";
}

function hasCustomCover(directory: string): Promise<boolean> {
  return exists(path.join(directory, CUSTOM_COVER));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/** Makes the folders `file` goes in below `directory`, refusing any that is a symbolic link or not a folder. */
async function ensureFolders(directory: string, file: string): Promise<void> {
  for (const folder of new Set([directory, path.dirname(path.join(directory, file))])) {
    await mkdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stats = await lstat(folder);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Unsafe project cover path: ${folder}`);
  }
}

async function removeFile(directory: string, file: string): Promise<void> {
  await ensureFolders(directory, file);
  await rm(path.join(directory, file), { force: true });
}

async function replaceFile(directory: string, file: string, contents: Uint8Array): Promise<void> {
  await ensureFolders(directory, file);
  const destination = path.join(directory, file);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
