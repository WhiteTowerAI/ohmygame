import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { PLUGIN_UI_STORAGE_MAX_BYTES } from "../shared/plugin-ui-protocol.js";
import { writeAtomically } from "./checkpoint-objects.js";

// A plugin page's own storage in a project. Pages run with an opaque origin,
// so they have no browser storage; this is what `storage.get` and
// `storage.set` reach. It lives with the project's data, not in its files,
// so it is not part of checkpoints and not committed with the project.

type Project = Pick<ProjectState, "id" | "workspacePath" | "storagePath">;

export class PluginPageStorageError extends Error {
  readonly statusCode = 400;
}

export class PluginPageStorage {
  readonly #queues = new Map<string, Promise<unknown>>();

  async get(project: Project, plugin: string, key: string): Promise<unknown> {
    return (await this.#read(project, plugin))[key] ?? null;
  }

  /** Sets a key, or removes it with `null`; refused past the size limit. */
  set(project: Project, plugin: string, key: string, value: unknown): Promise<void> {
    const file = this.#file(project, plugin);
    const previous = this.#queues.get(file) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const values = await this.#read(project, plugin);
        if (value === null) delete values[key];
        else values[key] = value;
        const text = JSON.stringify(values);
        if (Buffer.byteLength(text) > PLUGIN_UI_STORAGE_MAX_BYTES)
          throw new PluginPageStorageError(
            `A plugin keeps at most ${PLUGIN_UI_STORAGE_MAX_BYTES / 1024} KB in a project`,
          );
        await mkdir(path.dirname(file), { recursive: true });
        await writeAtomically(path.dirname(file), file, text);
      });
    this.#queues.set(file, next);
    return next;
  }

  #file(project: Project, plugin: string) {
    return path.join(
      project.storagePath ?? path.join(project.workspacePath, ".data"),
      "plugin-storage",
      `${plugin.replace("/", "__")}.json`,
    );
  }

  async #read(project: Project, plugin: string): Promise<Record<string, unknown>> {
    try {
      const value = JSON.parse(await readFile(this.#file(project, plugin), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
}
