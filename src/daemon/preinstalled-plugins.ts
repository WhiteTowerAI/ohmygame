import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPreparedPluginIndex, type PreparedPluginRelease } from "../shared/preinstalled-plugins.js";
import type { PluginOrigin } from "../shared/plugins.js";
import { extractPluginArchive } from "./plugin-installer.js";
import type { LocalPluginStore } from "./local-plugins.js";
import type { PluginServices } from "./plugin-services.js";

// Plugins the app brings along from other repositories. Unlike the bundled
// ones they install like any other, so the person can remove them; a receipt
// remembers that, and which release was last installed.

interface PreinstalledPluginReceipt {
  seededReleaseId: string;
  /** The version last installed from here, the only one an update replaces. */
  version?: string;
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

  async seed(services: PluginServices, formatOne: LocalPluginStore): Promise<string[]> {
    // Starting up waits for this, and needn't wait for the store with nothing to install.
    if (!this.#entries.length) return [];
    try {
      await services.ready();
    } catch (cause) {
      return [`Could not load plugins to install the preinstalled ones: ${cause instanceof Error ? cause.message : String(cause)}`];
    }
    const errors: string[] = [];
    for (const entry of this.#entries) {
      try {
        const receipt = this.#state.plugins[entry.pluginId];
        if (!receipt?.removed) {
          if (!services.index.get(entry.id, entry.version) || receipt?.seededReleaseId !== entry.releaseId) {
            await this.#install(entry, services);
            if (receipt?.version && receipt.version !== entry.version) await services.uninstall(entry.id, receipt.version);
          }
          if (receipt?.seededReleaseId !== entry.releaseId || receipt.version !== entry.version) {
            await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, version: entry.version, removed: false });
          }
        }
        // Format 1 kept its own copy of this plugin; it goes once the format 2 one has taken over.
        const older = `ohmygame:${entry.id.slice(entry.id.indexOf("/") + 1)}`;
        if ((await formatOne.read(older))?.source.type === "preinstalled") await formatOne.remove(older);
      } catch (cause) {
        errors.push(`Could not install preinstalled Plugin ${entry.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return errors;
  }

  async #install(entry: PreparedPluginRelease, services: PluginServices): Promise<void> {
    const archivePath = path.join(this.directory!, entry.artifactFile);
    const archive = await readFile(archivePath);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (archive.length !== entry.artifactBytes || digest !== entry.artifactSha256) {
      throw new Error("archive failed integrity verification");
    }
    const temporary = await mkdtemp(path.join(tmpdir(), "ohmygame-preinstalled-plugin-"));
    try {
      await extractPluginArchive(archivePath, temporary);
      const installed = await services.installManaged(temporary);
      if (installed.id !== entry.id || installed.version !== entry.version) {
        await services.uninstall(installed.id, installed.version);
        throw new Error(`the archive holds ${installed.id} ${installed.version}`);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Where the plugin came from, when the app brought it along. */
  origin(id: string): PluginOrigin | undefined {
    return this.#entries.find((entry) => entry.id === id)?.origin;
  }

  /** The person removed it, so it doesn't come back when the app starts. */
  async markRemoved(id: string): Promise<void> {
    const entry = this.#entries.find((item) => item.id === id);
    if (entry) await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, removed: true });
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
    Boolean(receipt) && typeof receipt.seededReleaseId === "string" && typeof receipt.removed === "boolean"
    && (receipt.version === undefined || typeof receipt.version === "string"));
}
