import { readdir } from "node:fs/promises";
import path from "node:path";
import { OHMYGAME_MARKETPLACE, type PluginDetail } from "../shared/plugins.js";
import { inspectPluginBundle } from "./local-plugins.js";
import { catalogManifest } from "./plugin-conversion.js";
import { indexPluginPackage } from "./plugin-index.js";
import { readPluginIconAsset } from "./plugin-icons.js";

const identity = {
  idPrefix: "ohmygame:",
  marketplace: OHMYGAME_MARKETPLACE,
  source: { type: "builtIn" as const },
};

/**
 * Bundled format 2 plugins that start off, as they did in format 1: those
 * still in beta for a platform the person may not use.
 */
export const BUNDLED_PLUGINS_OFF: readonly string[] = [
  "ohmygame/taptap-maker",
  "ohmygame/aseprite",
  "ohmygame/cocos-creator",
  "ohmygame/douyin-minigame",
  "ohmygame/tiled",
  "ohmygame/unity",
  "ohmygame/unreal-engine",
  "ohmygame/wechat-minigame",
];

export interface BundledPluginOptions {
  /**
   * The bundled format 2 packages. Those that only add Skills apply to every
   * project they suit, so the catalog shows them here, as `ohmygame:<name>`;
   * the format 2 plugin services leave them out.
   */
  formatTwoDirectory?: string;
  /** Format 2 plugins, by id, that start off until the person turns them on. */
  off?: readonly string[];
  onError?: (error: unknown) => void;
}

export class BundledPluginStore {
  #plugins: PluginDetail[] = [];
  #roots = new Map<string, string>();

  constructor(
    private readonly directory: string,
    private readonly options: BundledPluginOptions = {},
  ) {}

  async load(): Promise<void> {
    const plugins: PluginDetail[] = [];
    const roots = new Map<string, string>();
    for (const entry of await folders(this.directory)) {
      const root = path.join(this.directory, entry);
      const plugin = await inspectPluginBundle(root, identity);
      plugins.push(plugin);
      roots.set(plugin.id, root);
    }
    if (this.options.formatTwoDirectory) {
      for (const entry of await folders(this.options.formatTwoDirectory)) {
        const root = path.join(this.options.formatTwoDirectory, entry);
        try {
          const result = await indexPluginPackage(root);
          if (!result.ok) throw new Error(`${entry}: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
          if (!result.entry.id.startsWith("ohmygame/")) continue;
          const manifest = catalogManifest(result.entry, { enabledByDefault: !this.options.off?.includes(result.entry.id) });
          if (!manifest) continue;
          const plugin = await inspectPluginBundle(root, identity, manifest);
          // A format 1 plugin of the same name is the older copy.
          const older = plugins.findIndex((item) => item.id === plugin.id);
          if (older >= 0) plugins.splice(older, 1);
          plugins.push(plugin);
          roots.set(plugin.id, root);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    }
    this.#plugins = plugins.sort((left, right) => left.name.localeCompare(right.name));
    this.#roots = roots;
  }

  list(): PluginDetail[] {
    return this.#plugins;
  }

  read(id: string): PluginDetail | undefined {
    return this.#plugins.find((plugin) => plugin.id === id);
  }

  installedPath(id: string): string | undefined {
    return this.#roots.get(id);
  }

  async readIcon(id: string) {
    const plugin = this.read(id);
    const root = this.#roots.get(id);
    if (!plugin || !root) return undefined;
    return readPluginIconAsset(root, plugin.icon);
  }
}

async function folders(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}
