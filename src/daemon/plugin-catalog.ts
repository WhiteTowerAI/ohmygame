import type { PluginMention } from "../shared/contracts.js";
import {
  OHMYGAME_MARKETPLACE,
  PERSONAL_MARKETPLACE,
  type PluginCatalog,
  type PluginDetail,
  type PluginMarketplaceRef,
  type PluginSummary,
} from "../shared/plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";

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
    const plugins = uniquePlugins(adapterResults.flatMap((result) => result.plugins));
    return {
      plugins: plugins
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
    const found = results.flatMap((result) => result.plugin ? [result.plugin] : []);
    const plugin = found.find((candidate) => candidate.installed) ?? found[0];
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

  constructor(
    private readonly plugins: LocalPluginCatalogReader,
    private readonly summarize: (plugin: PluginDetail) => PluginSummary = pluginSummary,
  ) {}

  async list(): Promise<PluginCatalogResult> {
    const result = await this.plugins.list();
    return { plugins: result.plugins.map(this.summarize), errors: result.errors };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    return this.plugins.read(id);
  }
}

export class BundledPluginAdapter implements PluginCatalogAdapter {
  readonly marketplace = OHMYGAME_MARKETPLACE;

  constructor(
    private readonly plugins: { list(): PluginDetail[]; read(id: string): PluginDetail | undefined },
    private readonly summarize: (plugin: PluginDetail) => PluginSummary = pluginSummary,
  ) {}

  async list(): Promise<PluginCatalogResult> {
    return { plugins: this.plugins.list().map(this.summarize) };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    return this.plugins.read(id);
  }
}

export function pluginSummary(plugin: PluginDetail): PluginSummary {
  const { longDescription: _longDescription, skills: _skills, connections: _connections, defaultPrompts: _defaultPrompts, projectTypes: _projectTypes, mcpServers: _mcpServers, mcpConfigPath: _mcpConfigPath, configuration: _configuration, ...summary } = plugin;
  return summary;
}

function uniquePlugins(plugins: PluginSummary[]): PluginSummary[] {
  const unique = new Map<string, PluginSummary>();
  for (const plugin of plugins) {
    const current = unique.get(plugin.id);
    if (!current || plugin.installed) unique.set(plugin.id, plugin);
  }
  return [...unique.values()];
}
