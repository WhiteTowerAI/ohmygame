import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  pluginComponentKey,
  type PluginComponentSummary,
  type PluginDetail,
  type PluginSettings,
  type PluginSummary,
} from "../shared/plugins.js";

interface StoredPluginSettings {
  version: 2;
  plugins: Record<string, PluginSettings>;
}

interface LegacyPluginSettings {
  enabled?: boolean;
  components: Record<string, boolean>;
}

export class InvalidPluginSettingsError extends Error {}

export class PluginSettingsStore {
  readonly #filePath: string;
  #settings = new Map<string, PluginSettings>();
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "plugin-settings.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      const stored = parseStoredPluginSettings(value);
      if (!stored) throw new Error(`Invalid plugin settings: ${this.#filePath}`);
      this.#settings = new Map(Object.entries(stored.plugins).map(([id, settings]) => [id, cloneSettings(settings)]));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  resolve(plugin: PluginDetail): PluginSettings {
    const stored = this.#settings.get(plugin.id);
    const components = componentEntries(plugin).map(([key, component]) => [key, component.enabled] as const);
    const resolvedComponents = Object.fromEntries(components.map(([key, defaultEnabled]) => [key, stored?.components[key] ?? defaultEnabled]));
    return {
      enabled: stored?.enabled ?? true,
      components: resolvedComponents,
    };
  }

  decorateSummary(plugin: PluginSummary): PluginSummary {
    const stored = this.#settings.get(plugin.id);
    return { ...plugin, enabled: stored?.enabled ?? plugin.enabled };
  }

  decorate(plugin: PluginDetail): PluginDetail {
    const settings = this.resolve(plugin);
    const skills = plugin.skills.map((item) => ({
      ...item,
      enabled: settings.components[pluginComponentKey("skill", item.id)] ?? item.enabled,
    }));
    return {
      ...plugin,
      enabled: settings.enabled,
      skills,
    };
  }

  async update(plugin: PluginDetail, next: PluginSettings): Promise<PluginSettings> {
    const validKeys = new Set(componentEntries(plugin).map(([key]) => key));
    if (Object.keys(next.components).some((key) => !validKeys.has(key)) || Object.values(next.components).some((enabled) => typeof enabled !== "boolean")) {
      throw new InvalidPluginSettingsError("Invalid plugin component settings");
    }
    return this.#enqueueMutation(async () => {
      const resolved = this.resolve(plugin);
      const components = Object.fromEntries([...validKeys].map((key) => [key, next.components[key] ?? resolved.components[key] ?? true]));
      const settings = { enabled: next.enabled, components };
      const updated = new Map(this.#settings);
      updated.set(plugin.id, settings);
      await this.#write(updated);
      this.#settings = updated;
      return cloneSettings(settings);
    });
  }

  async remove(pluginId: string): Promise<void> {
    await this.#enqueueMutation(async () => {
      const updated = new Map(this.#settings);
      if (!updated.delete(pluginId)) return;
      await this.#write(updated);
      this.#settings = updated;
    });
  }

  #enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(mutation);
    this.#writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async #write(settings: Map<string, PluginSettings>): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    const stored: StoredPluginSettings = {
      version: 2,
      plugins: Object.fromEntries(settings),
    };
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function componentEntries(plugin: PluginDetail): Array<[string, PluginComponentSummary]> {
  return plugin.skills.map((item) => [pluginComponentKey("skill", item.id), item]);
}

function cloneSettings(settings: PluginSettings): PluginSettings {
  return { enabled: settings.enabled, components: { ...settings.components } };
}

function parseStoredPluginSettings(value: unknown): StoredPluginSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stored = value as Record<string, unknown>;
  if ((stored.version !== 1 && stored.version !== 2) || !stored.plugins || typeof stored.plugins !== "object" || Array.isArray(stored.plugins)) return undefined;
  const plugins = stored.plugins as Record<string, unknown>;
  const valid = Object.values(plugins).every((settings) => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
    const candidate = settings as Partial<PluginSettings>;
    return (stored.version === 1 || typeof candidate.enabled === "boolean") && candidate.components !== undefined && typeof candidate.components === "object" && !Array.isArray(candidate.components) &&
      Object.values(candidate.components).every((enabled) => typeof enabled === "boolean");
  });
  if (!valid) return undefined;
  if (stored.version === 2) return stored as unknown as StoredPluginSettings;
  return {
    version: 2,
    plugins: Object.fromEntries(Object.entries(plugins).map(([id, value]) => {
      const legacy = value as LegacyPluginSettings;
      const components = Object.fromEntries(Object.entries(legacy.components).flatMap(([key, enabled]) => {
        if (key.startsWith("skill:")) return [[key, enabled]];
        return [];
      }));
      return [id, { enabled: legacy.enabled ?? Object.values(components).some(Boolean), components }];
    })),
  };
}
