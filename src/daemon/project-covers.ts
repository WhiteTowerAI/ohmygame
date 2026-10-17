import { randomUUID } from "node:crypto";
import { access, copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectCoverMode, ProjectCoverState } from "../shared/contracts.js";

const CUSTOM_COVER = "cover.webp";
const AUTOMATIC_COVER = "cover-auto.webp";
const FROZEN_COVER = "cover-frozen.webp";
const COVER_STATE = "cover-state.json";

/** Cover operations share a queue so a late automatic capture cannot overwrite a custom cover. */
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
      await replaceFile(path.join(directory, source === "custom" ? CUSTOM_COVER : AUTOMATIC_COVER), contents);
      if (source === "custom") {
        await replaceFile(path.join(directory, COVER_STATE), Buffer.from(`${JSON.stringify({ mode: source })}\n`));
        await rm(path.join(directory, FROZEN_COVER), { force: true });
      }
    });
  }

  setMode(directory: string, mode: ProjectCoverMode, fallback?: Uint8Array): Promise<void> {
    return this.#serial(directory, async () => {
      if (await coverMode(directory) === mode) return;
      if (mode === "auto") {
        await rm(path.join(directory, FROZEN_COVER), { force: true });
      } else if (!await hasCustomCover(directory)) {
        const current = await readOptional(path.join(directory, AUTOMATIC_COVER)) ?? fallback;
        if (current) await replaceFile(path.join(directory, FROZEN_COVER), current);
      }
      await replaceFile(path.join(directory, COVER_STATE), Buffer.from(`${JSON.stringify({ mode })}\n`));
    });
  }

  copy(source: string, destination: string): Promise<void> {
    return this.#serial(source, async () => {
      for (const file of [CUSTOM_COVER, AUTOMATIC_COVER, FROZEN_COVER, COVER_STATE]) {
        await copyFile(path.join(source, file), path.join(destination, file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
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

async function hasCustomCover(directory: string): Promise<boolean> {
  try {
    await access(path.join(directory, CUSTOM_COVER));
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

async function replaceFile(destination: string, contents: Uint8Array): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
