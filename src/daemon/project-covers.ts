import { randomUUID } from "node:crypto";
import { access, copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectCoverMode, ProjectCoverState } from "../shared/contracts.js";

const CUSTOM_COVER = "cover.webp";
const AUTOMATIC_COVER = "cover-auto.webp";

/** Cover operations share a queue so a late automatic capture cannot overwrite a custom cover. */
export class ProjectCovers {
  readonly #operations = new Map<string, Promise<unknown>>();

  state(directory: string): Promise<ProjectCoverState> {
    return this.#serial(directory, async () => ({ mode: await hasCustomCover(directory) ? "custom" : "auto" }));
  }

  read(directory: string): Promise<Buffer | undefined> {
    return this.#serial(directory, async () =>
      (await readOptional(path.join(directory, CUSTOM_COVER))) ?? readOptional(path.join(directory, AUTOMATIC_COVER)),
    );
  }

  set(directory: string, contents: Uint8Array, source: ProjectCoverMode): Promise<void> {
    return this.#serial(directory, async () => {
      if (source === "auto" && await hasCustomCover(directory)) return;
      await replaceFile(path.join(directory, source === "custom" ? CUSTOM_COVER : AUTOMATIC_COVER), contents);
    });
  }

  restoreAutomatic(directory: string): Promise<void> {
    return this.#serial(directory, () => rm(path.join(directory, CUSTOM_COVER), { force: true }));
  }

  copy(source: string, destination: string): Promise<void> {
    return this.#serial(source, async () => {
      for (const file of [CUSTOM_COVER, AUTOMATIC_COVER]) {
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
