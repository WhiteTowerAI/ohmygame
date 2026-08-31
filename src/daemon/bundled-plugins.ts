import { readdir } from "node:fs/promises";
import path from "node:path";
import { OPENGAME_MARKETPLACE, type PluginDetail } from "../shared/plugins.js";
import { inspectPluginBundle } from "./local-plugins.js";

const identity = {
  idPrefix: "opengame:",
  marketplace: OPENGAME_MARKETPLACE,
  source: { type: "builtIn" as const },
};

export class BundledPluginStore {
  #plugins: PluginDetail[] = [];

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        this.#plugins = [];
        return;
      }
      throw cause;
    }
    this.#plugins = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => inspectPluginBundle(path.join(this.directory, entry.name), identity)));
  }

  list(): PluginDetail[] {
    return this.#plugins;
  }

  read(id: string): PluginDetail | undefined {
    return this.#plugins.find((plugin) => plugin.id === id);
  }

  installedPath(id: string): string | undefined {
    const plugin = this.read(id);
    return plugin ? path.join(this.directory, plugin.name) : undefined;
  }
}
