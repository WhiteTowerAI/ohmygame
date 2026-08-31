import type { PluginMention } from "../shared/contracts.js";
import { GODOT_MCP_SERVER_ID } from "../shared/mcp.js";
import {
  OPENGAME_MARKETPLACE,
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
      plugins: uniquePlugins(adapterResults.flatMap((result) => result.plugins)).map((plugin) => this.settings.decorateSummary(plugin)),
      errors: results.flatMap((entry) => {
        const messages = entry.error ? [entry.error] : entry.result?.errors ?? [];
        return messages.map((message) => ({ marketplaceId: entry.adapter.marketplace.id, message }));
      }),
    };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    for (const adapter of this.adapters) {
      const plugin = await adapter.read(id);
      if (plugin) return this.settings.decorate(plugin);
    }
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

export class BuiltInPluginAdapter implements PluginCatalogAdapter {
  readonly marketplace = OPENGAME_MARKETPLACE;

  constructor(
    private readonly godotEnabled: () => Promise<boolean>,
  ) {}

  async list(): Promise<PluginCatalogResult> {
    return { plugins: (await this.details()).map(pluginSummary) };
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    return (await this.details()).find((plugin) => plugin.id === id);
  }

  private async details(): Promise<PluginDetail[]> {
    return builtInPlugins(await this.godotEnabled());
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

export function builtInPlugins(godotEnabled = true): PluginDetail[] {
  return [godotPlugin(godotEnabled)];
}

export function godotPlugin(connectionEnabled = true): PluginDetail {
  return {
    id: "opengame:godot",
    name: "godot",
    displayName: "Godot",
    description: "Connect the agent to the Godot editor.",
    marketplace: OPENGAME_MARKETPLACE,
    source: { type: "builtIn" },
    installed: true,
    enabled: true,
    skills: [],
    connections: [{ id: GODOT_MCP_SERVER_ID, name: "Godot", enabled: connectionEnabled }],
  };
}

function pluginSummary(plugin: PluginDetail): PluginSummary {
  const { skills: _skills, connections: _connections, ...summary } = plugin;
  return summary;
}

function uniquePlugins(plugins: PluginSummary[]): PluginSummary[] {
  return [...new Map(plugins.map((plugin) => [plugin.id, plugin])).values()];
}
