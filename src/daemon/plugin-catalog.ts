import type { PluginMention } from "../shared/contracts.js";
import {
  OPENGAME_MARKETPLACE,
  PERSONAL_MARKETPLACE,
  isNewerPluginVersion,
  type PluginCatalog,
  type PluginDetail,
  type PluginMarketplaceRef,
  type PluginSummary,
} from "../shared/plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";
import type { RemotePublisher } from "./publish/client.js";

export interface PluginCatalogResult {
  plugins: PluginSummary[];
  errors?: string[];
}

export interface PluginCatalogAdapter {
  readonly marketplace: PluginMarketplaceRef;
  list(): Promise<PluginCatalogResult>;
  read(id: string): Promise<PluginDetail | undefined>;
}

export class PluginCatalogService {
  constructor(
    private readonly adapters: readonly PluginCatalogAdapter[],
    private readonly settings: PluginSettingsStore,
    private readonly decoratePlugin: <T extends PluginSummary | PluginDetail>(plugin: T) => T = (plugin) => plugin,
  ) {}

  async list(): Promise<PluginCatalog> {
    const results = await Promise.all(this.adapters.map(async (adapter) => {
      try {
        return { adapter, result: await adapter.list() };
      } catch (cause) {
        return { adapter, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }));
    const adapterResults = results.flatMap((entry) => entry.result ? [entry.result] : []);
    return {
      plugins: uniquePlugins(adapterResults.flatMap((result) => result.plugins))
        .map((plugin) => this.decoratePlugin(this.settings.decorateSummary(plugin))),
      errors: results.flatMap((entry) => {
        const messages = entry.error ? [entry.error] : entry.result?.errors ?? [];
        return messages.map((message) => ({ marketplaceId: entry.adapter.marketplace.id, message }));
      }),
    };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    const results = await Promise.all(this.adapters.map(async (adapter) => {
      try {
        return { plugin: await adapter.read(id) };
      } catch (error) {
        return { error };
      }
    }));
    const plugins = results.flatMap((result) => result.plugin ? [result.plugin] : []);
    const installed = plugins.find((plugin) => plugin.installed);
    const remote = plugins.find((plugin) => plugin.source.type === "catalog" && !plugin.installed);
    const plugin = installed && remote && installed.source.type === "catalog"
      ? {
          ...installed,
          latestVersion: remote.version,
          updateAvailable: Boolean(installed.version && remote.version && isNewerPluginVersion(remote.version, installed.version)),
          author: remote.author,
          stats: remote.stats,
          origin: remote.origin,
          curation: remote.curation,
        }
      : installed ?? remote ?? plugins[0];
    if (plugin) return this.decoratePlugin(this.settings.decorate(plugin));
    const failure = results.find((result) => result.error !== undefined);
    if (failure) throw failure.error;
    return undefined;
  }

  async validateMentions(mentions: readonly PluginMention[]): Promise<PluginMention[]> {
    const catalog = await this.list();
    const validated: PluginMention[] = [];
    for (const mention of mentions) {
      const plugin = catalog.plugins.find((candidate) => candidate.marketplace.id === mention.marketplaceId && candidate.name === mention.name);
      if (!plugin?.installed) throw new Error(`Plugin ${mention.displayName} is not installed`);
      if (!plugin.enabled) throw new Error(`Plugin ${mention.displayName} is disabled`);
      if (!validated.some((item) => item.name === plugin.name && item.marketplaceId === plugin.marketplace.id)) {
        validated.push({ name: plugin.name, displayName: plugin.displayName, marketplaceId: plugin.marketplace.id });
      }
    }
    return validated;
  }
}

export interface LocalPluginCatalogReader {
  list(): Promise<{ plugins: PluginDetail[]; errors: string[] }>;
  read(id: string): Promise<PluginDetail | undefined>;
}

export class LocalPluginAdapter implements PluginCatalogAdapter {
  readonly marketplace = PERSONAL_MARKETPLACE;

  constructor(private readonly plugins: LocalPluginCatalogReader) {}

  async list(): Promise<PluginCatalogResult> {
    const result = await this.plugins.list();
    return { plugins: result.plugins.map(pluginSummary), errors: result.errors };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    return this.plugins.read(id);
  }
}

export class BundledPluginAdapter implements PluginCatalogAdapter {
  readonly marketplace = OPENGAME_MARKETPLACE;

  constructor(private readonly plugins: { list(): PluginDetail[]; read(id: string): PluginDetail | undefined }) {}

  async list(): Promise<PluginCatalogResult> {
    return { plugins: this.plugins.list().map(pluginSummary) };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    return this.plugins.read(id);
  }
}

export class RemotePluginAdapter implements PluginCatalogAdapter {
  readonly marketplace = OPENGAME_MARKETPLACE;
  readonly #plugins = new Map<string, import("../shared/publish-v1.js").PublishExplorePlugin>();

  constructor(private readonly publisher: Pick<RemotePublisher, "explorePlugins" | "explorePlugin">) {}

  async list(): Promise<PluginCatalogResult> {
    const plugins = await this.publisher.explorePlugins();
    this.#plugins.clear();
    for (const plugin of plugins) this.#plugins.set(`opengame:${plugin.name}`, plugin);
    return { plugins: plugins.map(remotePluginSummary) };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    if (!id.startsWith("opengame:")) return undefined;
    try {
      const cached = this.#plugins.get(id) ?? (await this.publisher.explorePlugins())
        .find((plugin) => `opengame:${plugin.name}` === id);
      if (!cached) return undefined;
      return remotePluginDetail(await this.publisher.explorePlugin(cached.id));
    } catch (cause) {
      if ((cause as { statusCode?: number }).statusCode === 404) return undefined;
      throw cause;
    }
  }
}

function pluginSummary(plugin: PluginDetail): PluginSummary {
  const { longDescription: _longDescription, skills: _skills, connections: _connections, defaultPrompts: _defaultPrompts, projectTypes: _projectTypes, ...summary } = plugin;
  return summary;
}

function uniquePlugins(plugins: PluginSummary[]): PluginSummary[] {
  const unique = new Map<string, PluginSummary>();
  for (const plugin of plugins) {
    const current = unique.get(plugin.id);
    if (!current) {
      unique.set(plugin.id, plugin);
      continue;
    }
    if (plugin.installed) {
      unique.set(plugin.id, {
        ...plugin,
        ...(plugin.source.type === "catalog" && current.source.type === "catalog" ? {
          latestVersion: current.version,
          updateAvailable: Boolean(plugin.version && current.version && isNewerPluginVersion(current.version, plugin.version)),
          author: current.author,
          stats: current.stats,
          origin: current.origin,
          curation: current.curation,
        } : {}),
      });
    } else if (current.installed && current.source.type === "catalog" && plugin.source.type === "catalog") {
      unique.set(plugin.id, {
        ...current,
        latestVersion: plugin.version,
        updateAvailable: Boolean(current.version && plugin.version && isNewerPluginVersion(plugin.version, current.version)),
        author: plugin.author,
        stats: plugin.stats,
        origin: plugin.origin,
        curation: plugin.curation,
      });
    }
  }
  return [...unique.values()];
}

function remotePluginSummary(plugin: import("../shared/publish-v1.js").PublishExplorePlugin): PluginSummary {
  const manifest = plugin.manifest;
  return {
    id: `opengame:${plugin.name}`,
    name: plugin.name,
    displayName: manifest.interface?.displayName ?? displayName(plugin.name),
    description: manifest.interface?.shortDescription ?? manifest.description,
    version: plugin.version,
    latestVersion: plugin.version,
    marketplace: OPENGAME_MARKETPLACE,
    source: { type: "catalog", pluginId: plugin.id, releaseId: plugin.releaseId },
    installed: false,
    enabled: false,
    author: plugin.author,
    stats: plugin.stats,
    origin: plugin.origin,
    curation: plugin.curation,
  };
}

function remotePluginDetail(plugin: import("../shared/publish-v1.js").PublishExplorePlugin): PluginDetail {
  const summary = remotePluginSummary(plugin);
  return {
    ...summary,
    longDescription: plugin.manifest.interface?.longDescription,
    skills: (plugin.skills ?? []).map((skill) => ({ ...skill, enabled: true })),
    connections: (plugin.manifest.connections ?? []).map((id) => ({ id, name: displayName(id.replace(/^opengame-/, "")), enabled: true })),
    defaultPrompts: plugin.manifest.interface?.defaultPrompt,
    projectTypes: plugin.manifest.interface?.projectTypes,
  };
}

function displayName(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
