import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPreparedPluginIndex, type PreparedPluginRelease } from "../shared/preinstalled-plugins.js";
import { PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_ARCHIVE_MAX_ENTRIES, type PluginOrigin } from "../shared/plugins.js";
import { extractArchive } from "./archive-extraction.js";
import { unpackPlugin } from "./plugin-pack.js";
import { indexPluginPackage } from "./plugin-index.js";
import type { PluginSources } from "./plugin-sources.js";
import type { PluginServices } from "./plugin-services.js";

// Plugins the app brings along from other repositories. Unlike the bundled
// ones they install like any other, so the person can remove them; a receipt
// remembers that, and which release was last installed.

interface PreinstalledPluginReceipt {
  seededReleaseId: string;
  /** The version last installed from here, the only one an update replaces. */
  version?: string;
  removed: boolean;
  /** Identifies the exact npm seed; independent copies are not labelled preinstalled. */
  digest?: string;
  [key: string]: unknown;
}

// compat: since beta.5.6, remove from beta.7 and 2026-12-07. Plugins the app
// used to bring along, by their lock file id. A copy it installed that the
// person didn't remove goes too; a receipt doesn't name the plugin itself.
const RETIRED: Readonly<Record<string, string>> = {
  "98d626d2-8e51-42a9-adfe-a3a1e19372c9": "ohmygame/img2threejs",
};

interface PreinstalledPluginState {
  version: 1;
  plugins: Record<string, PreinstalledPluginReceipt>;
  [key: string]: unknown;
}

export class PreinstalledPluginManager {
  readonly #statePath: string;
  #ready?: Promise<void>;
  #writes = Promise.resolve();
  #removed = new Set<string>();
  #entries: PreparedPluginRelease[] = [];
  #state: PreinstalledPluginState = { version: 1, plugins: {} };

  constructor(private readonly directory: string | undefined, dataDirectory: string) {
    this.#statePath = path.join(dataDirectory, "plugins", "preinstalled-plugins.json");
  }

  load(): Promise<void> {
    return this.#ready ??= this.#load();
  }

  /** Suppress the old bundled source, including after the person removes its seed. */
  async bundledReplacements(): Promise<ReadonlySet<string>> {
    await this.load();
    return new Set(this.#entries.filter((entry) => entry.origin.type === "npm").map((entry) => entry.id));
  }

  #receipt(pluginId: string): PreinstalledPluginReceipt | undefined {
    return Object.hasOwn(this.#state.plugins, pluginId) ? this.#state.plugins[pluginId] : undefined;
  }

  async #load(): Promise<void> {
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

  async seed(services: PluginServices, sources?: PluginSources): Promise<string[]> {
    await this.load();
    const retired = Object.entries(RETIRED).filter(([pluginId]) => {
      const receipt = this.#receipt(pluginId);
      return receipt && !receipt.removed && !this.#entries.some((entry) => entry.pluginId === pluginId);
    });
    // Starting up waits for this, and needn't wait for the store with nothing to do.
    if (!this.#entries.length && !retired.length) return [];
    try {
      await services.ready();
    } catch (cause) {
      return [`Could not load plugins to install the preinstalled ones: ${cause instanceof Error ? cause.message : String(cause)}`];
    }
    const errors: string[] = [];
    for (const [pluginId, id] of retired) {
      const receipt = this.#receipt(pluginId)!;
      try {
        if (receipt.version && services.index.get(id, receipt.version)) await services.uninstall(id, receipt.version);
        await this.#setReceipt(pluginId, { seededReleaseId: receipt.seededReleaseId, removed: true });
      } catch (cause) {
        errors.push(`Could not remove retired preinstalled Plugin ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    for (const entry of this.#entries) {
      try {
        const receipt = this.#receipt(entry.pluginId);
        if (!receipt?.removed && !this.#removed.has(entry.pluginId)) {
          if (entry.origin.type === "npm") {
            if (!sources) throw new Error("Npm preinstallation requires the plugin source store");
            await this.#install(entry, services, sources);
            continue;
          }
          if (!services.index.get(entry.id, entry.version) || receipt?.seededReleaseId !== entry.releaseId) {
            await this.#install(entry, services);
            if (receipt?.version && receipt.version !== entry.version) await services.uninstall(entry.id, receipt.version);
          }
          if (receipt?.seededReleaseId !== entry.releaseId || receipt.version !== entry.version) {
            await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, version: entry.version, removed: false });
          }
        }
      } catch (cause) {
        errors.push(`Could not install preinstalled Plugin ${entry.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return errors;
  }

  async #install(entry: PreparedPluginRelease, services: PluginServices, sources?: PluginSources): Promise<void> {
    const archivePath = path.join(this.directory!, entry.artifactFile);
    const archive = await readFile(archivePath);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (archive.length !== entry.artifactBytes || digest !== entry.artifactSha256) {
      throw new Error("archive failed integrity verification");
    }
    const temporary = await mkdtemp(path.join(tmpdir(), "ohmygame-preinstalled-plugin-"));
    try {
      let root = temporary;
      if (entry.artifactFile.endsWith(".tgz")) {
        root = await unpackPlugin(archivePath, temporary, { published: true, error: (reason) => new Error(`the archive can't be read: ${reason}`) });
        const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
        if (entry.origin.type !== "npm" || pkg.name !== entry.origin.package || pkg.version !== entry.version)
          throw new Error("npm package identity does not match the prepared index");
      } else await extractArchive(archivePath, temporary, {
        maxEntries: PLUGIN_ARCHIVE_MAX_ENTRIES,
        maxBytes: PLUGIN_ARCHIVE_MAX_BYTES,
        error: (reason) => new Error(`the archive can't be read: ${reason}`),
      });
      // Validate before touching an installed package: an incorrect archive must
      // never replace/delete another plugin, even briefly.
      const checked = await indexPluginPackage(root);
      if (!checked.ok) throw new Error("the archive is not a valid plugin");
      if (checked.entry.id !== entry.id || checked.entry.version !== entry.version)
        throw new Error(`the archive holds ${checked.entry.id} ${checked.entry.version}`);
      if (entry.origin.type === "npm") {
        const installed = await sources!.installPreinstalled(root, entry.origin, async () => {
          if (this.#removed.has(entry.pluginId) || this.#receipt(entry.pluginId)?.removed) throw new Error("Preinstalled plugin was removed");
        });
        if (installed) await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, version: entry.version, digest: installed.digest, removed: false });
      } else await services.installManaged(root);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Where the plugin came from, when the app brought it along. */
  origin(id: string, version: string, digest: string): PluginOrigin | undefined {
    const entry = this.#entries.find((entry) => entry.id === id && entry.version === version);
    if (!entry) return undefined;
    if (entry.origin.type === "npm") {
      const receipt = this.#receipt(entry.pluginId);
      if (!receipt || receipt.removed || receipt.version !== version || receipt.digest !== digest) return undefined;
    }
    return entry.origin;
  }

  /** The person removed it, so it doesn't come back when the app starts. */
  async markRemoved(id: string): Promise<void> {
    await this.load();
    const entry = this.#entries.find((item) => item.id === id);
    if (entry) this.#removed.add(entry.pluginId);
    if (entry) await this.#setReceipt(entry.pluginId, { seededReleaseId: entry.releaseId, removed: true });
  }

  #setReceipt(pluginId: string, receipt: PreinstalledPluginReceipt): Promise<void> {
    const write = this.#writes.catch(() => {}).then(() => this.#writeReceipt(pluginId, receipt));
    this.#writes = write;
    return write;
  }

  async #writeReceipt(pluginId: string, receipt: PreinstalledPluginReceipt): Promise<void> {
    await this.load();
    const next: PreinstalledPluginState = {
      ...this.#state,
      plugins: { ...this.#state.plugins, [pluginId]: { ...this.#receipt(pluginId), ...receipt, removed: receipt.removed || this.#receipt(pluginId)?.removed === true || this.#removed.has(pluginId) } },
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
  return state.version === 1 && Boolean(state.plugins) && typeof state.plugins === "object" && !Array.isArray(state.plugins) && Object.values(state.plugins ?? {}).every((receipt) =>
    Boolean(receipt) && typeof receipt === "object" && !Array.isArray(receipt) && typeof receipt.seededReleaseId === "string" && typeof receipt.removed === "boolean"
    && (receipt.version === undefined || typeof receipt.version === "string")
    && (receipt.digest === undefined || typeof receipt.digest === "string"));
}
