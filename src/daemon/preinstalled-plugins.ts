import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPreparedPluginIndex, type PreparedPluginRelease } from "../shared/preinstalled-plugins.js";
import type { PluginDetail, PluginSummary } from "../shared/plugins.js";
import { installPreparedPlugin } from "./plugin-installer.js";
import type { LocalPluginStore } from "./local-plugins.js";

interface PreinstalledPluginReceipt {
  seededReleaseId: string;
  removed: boolean;
}

interface PreinstalledPluginState {
  version: 1;
  plugins: Record<string, PreinstalledPluginReceipt>;
}

export class PreinstalledPluginManager {
  readonly #statePath: string;
  #entries: PreparedPluginRelease[] = [];
  #state: PreinstalledPluginState = { version: 1, plugins: {} };

  constructor(private readonly directory: string | undefined, dataDirectory: string) {
    this.#statePath = path.join(dataDirectory, "plugins", "preinstalled-plugins.json");
  }

  async load(): Promise<void> {
    if (this.directory) {
      const value = JSON.parse(await readFile(path.join(this.directory, "index.json"), "utf8")) as unknown;
      if (!isPreparedPluginIndex(value)) throw new Error("Invalid preinstalled Plugin index");
      this.#entries = value.plugins;
    }
    try {
      const value = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!isState(value)) throw new Error("Invalid preinstalled Plugin state");
      this.#state = value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  async seed(store: LocalPluginStore): Promise<string[]> {
    const errors: string[] = [];
    for (const entry of this.#entries) {
      const receipt = this.#state.plugins[entry.pluginId];
      if (receipt?.removed) continue;
      const id = `ohmygame:${entry.name}`;
      try {
        const installed = await store.read(id);
        if (!installed || receipt?.seededReleaseId !== entry.releaseId) {
          const archive = await readFile(path.join(this.directory!, entry.artifactFile));
          const digest = createHash("sha256").update(archive).digest("hex");
          if (archive.length !== entry.artifactBytes || digest !== entry.artifactSha256) {
            throw new Error("archive failed integrity verification");
          }
          await installPreparedPlugin(store, {
            pluginId: entry.pluginId,
            releaseId: entry.releaseId,
            manifest: entry.manifest,
            archive,
          });
        }
        if (receipt?.seededReleaseId !== entry.releaseId) {
          await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, removed: false });
        }
      } catch (cause) {
        errors.push(`Could not install preinstalled Plugin ${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return errors;
  }

  decorate<T extends PluginSummary | PluginDetail>(plugin: T): T {
    const pluginId = plugin.source.type === "preinstalled" ? plugin.source.pluginId : undefined;
    const entry = pluginId ? this.#entries.find((candidate) => candidate.pluginId === pluginId) : undefined;
    return entry
      ? {
          ...plugin,
          origin: plugin.origin ?? entry.origin,
          ...(plugin.installed ? { preinstalled: true } : {}),
        }
      : plugin;
  }

  async markRemoved(plugin: PluginSummary | PluginDetail): Promise<void> {
    if (plugin.source.type !== "preinstalled") return;
    const pluginId = plugin.source.pluginId;
    const entry = this.#entries.find((item) => item.pluginId === pluginId);
    if (!entry) return;
    await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, removed: true });
  }

  async #setReceipt(pluginId: string, receipt: PreinstalledPluginReceipt): Promise<void> {
    const next: PreinstalledPluginState = {
      version: 1,
      plugins: { ...this.#state.plugins, [pluginId]: receipt },
    };
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.#statePath);
      this.#state = next;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function isState(value: unknown): value is PreinstalledPluginState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<PreinstalledPluginState>;
  return state.version === 1 && Boolean(state.plugins) && Object.values(state.plugins ?? {}).every((receipt) =>
    Boolean(receipt) && typeof receipt.seededReleaseId === "string" && typeof receipt.removed === "boolean");
}
