import type { ModelRuntime, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { PluginProviderInfo } from "../shared/contracts.js";
import { customModelCatalog, knownCustomModel, type CustomModelCatalog } from "./custom-model-capabilities.js";
import { localizePluginString, type PluginIndexEntry, type PluginLocale } from "./plugin-index.js";
import type { PluginServices } from "./plugin-services.js";
import { discoverProviderModels, namedNotForChat } from "./provider-model-discovery.js";

// The model providers installed plugins add (`contributes.providers`). Each
// joins the model runtime as a provider of its own, like one the person adds
// in Settings → Providers, while its plugin is installed and not disabled
// everywhere; per-project switches don't apply. Its key is the plugin's
// secret setting it names, read by the app; the plugin's code never sees it.
// A provider with a key field joins only once the key is set.

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type RefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];
type ProviderChatModel = Extract<ProviderModelConfig, { reasoning: boolean }>;
type ManifestProvider = NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number];

/** What a provider sends when it needs no key; compatible local services accept any. */
const NO_KEY = "ohmygame-local";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface PluginModelProvider {
  /** The provider's id in the model runtime and in model references. */
  id: string;
  entry: PluginIndexEntry;
  provider: ManifestProvider;
  /** Whether it is in the model runtime: its key is set, or it needs none. */
  configured: boolean;
}

/** `plugin.<publisher>.<name>.<provider>`; none of those parts has a dot. */
export function pluginModelProviderId(pluginId: string, providerId: string): string {
  return `plugin.${pluginId.replace("/", ".")}.${providerId}`;
}

export class PluginModelProviders {
  #providers = new Map<string, PluginModelProvider>();
  /** What each registered provider was registered with, to skip unchanged ones. */
  readonly #registered = new Map<string, string>();
  /** The last model list each discovering provider fetched. */
  readonly #discovered = new Map<string, ProviderModelConfig[]>();
  #queue: Promise<string[]> = Promise.resolve([]);

  constructor(
    private readonly services: PluginServices,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Whether a provider id belongs to a plugin's provider, set up or not. */
  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): PluginModelProvider[] {
    return [...this.#providers.values()];
  }

  /** How Settings shows a plugin's provider. */
  info(id: string, locale: PluginLocale): PluginProviderInfo | undefined {
    const item = this.#providers.get(id);
    if (!item) return undefined;
    const keyField = item.provider.apiKey ? item.entry.manifest.configuration?.[item.provider.apiKey] : undefined;
    return {
      id: item.entry.id,
      name: localizePluginString(item.entry, item.entry.manifest.displayName, locale),
      ...(item.provider.baseUrl ? { baseUrl: item.provider.baseUrl } : {}),
      ...(item.provider.apiKey ? { keySetting: item.provider.apiKey } : {}),
      ...(keyField?.description ? { keyHint: localizePluginString(item.entry, keyField.description, locale) } : {}),
      ...(item.provider.icon ? { icon: item.entry.digest } : {}),
    };
  }

  /** Where a provider's icon is in its plugin's package, when it has one. */
  iconFile(id: string): { root: string; path: string } | undefined {
    const item = this.#providers.get(id);
    return item?.provider.icon ? { root: item.entry.root, path: item.provider.icon } : undefined;
  }

  /** What a provider makes: chat, and the kinds of media its adapter makes. */
  capabilities(id: string): Array<"language" | "image" | "video" | "audio" | "3d"> {
    const provider = this.#providers.get(id)?.provider;
    if (!provider) return [];
    return [
      ...(provider.api ? ["language" as const] : []),
      ...(provider.media?.image ? ["image" as const] : []),
      ...(provider.media?.video ? ["video" as const] : []),
      ...(provider.media?.audio ? ["audio" as const] : []),
      ...(provider.media?.["3d"] ? ["3d" as const] : []),
    ];
  }

  title(id: string, locale: PluginLocale): string | undefined {
    const item = this.#providers.get(id);
    return item ? localizePluginString(item.entry, item.provider.title, locale) : undefined;
  }

  /**
   * Brings the model runtime in line with the installed plugins and their
   * keys. Resolves to the ids it registered, changed or removed.
   */
  sync(runtime: ModelRuntime | Promise<ModelRuntime>): Promise<string[]> {
    const next = this.#queue.catch(() => []).then(async () => this.#sync(await runtime));
    this.#queue = next;
    return next;
  }

  /** Waits for syncs already asked for, so a list reflects the latest change. */
  async settled(): Promise<void> {
    await this.#queue.catch(() => {});
  }

  async #sync(runtime: ModelRuntime): Promise<string[]> {
    const providers = new Map<string, PluginModelProvider>();
    const wanted = new Map<string, { signature: string; config: ProviderConfig }>();
    const catalog = customModelCatalog(runtime.getModels());
    for (const entry of await this.services.installed()) {
      for (const provider of entry.manifest.contributes?.providers ?? []) {
        const id = pluginModelProviderId(entry.id, provider.id);
        const key = provider.apiKey ? this.services.values.secret(entry, provider.apiKey) : NO_KEY;
        providers.set(id, { id, entry, provider, configured: key !== undefined });
        // Only chat joins the model runtime; a provider that only makes media has none.
        if (key === undefined || !provider.api || !provider.baseUrl) continue;
        const { api, baseUrl } = provider;
        const signature = JSON.stringify([entry.id, entry.version, provider, key]);
        const models = (provider.models ?? []).map((model) =>
          chatModel(model.id, model.title ? localizePluginString(entry, model.title, "en") : model.id, api, catalog));
        wanted.set(id, {
          signature,
          config: {
            name: localizePluginString(entry, provider.title, "en"),
            baseUrl,
            api,
            apiKey: literalConfigValue(key),
            models,
            ...(provider.discoverModels
              ? { refreshModels: (context: RefreshContext) => this.#discover(runtime, id, signature, { ...provider, api, baseUrl }, key, models, context) }
              : {}),
          },
        });
      }
    }
    this.#providers = providers;
    const changed: string[] = [];
    for (const id of this.#registered.keys()) {
      if (wanted.get(id)?.signature === this.#registered.get(id)) continue;
      // Re-registering keeps fields the new registration leaves out, so start over.
      runtime.unregisterProvider(id);
      this.#registered.delete(id);
      this.#discovered.delete(id);
      changed.push(id);
    }
    for (const [id, { signature, config }] of wanted) {
      if (this.#registered.has(id)) continue;
      try {
        runtime.registerProvider(id, config);
        this.#registered.set(id, signature);
        if (!changed.includes(id)) changed.push(id);
      } catch {
        // A provider the model runtime refuses stays out; the others still join.
        providers.set(id, { ...providers.get(id)!, configured: false });
      }
    }
    return changed;
  }

  /** The models a discovering provider lists, or the last list when it can't look. */
  async #discover(runtime: ModelRuntime, id: string, signature: string, provider: ManifestProvider & Required<Pick<ManifestProvider, "api" | "baseUrl">>, key: string, listed: ProviderModelConfig[], context: RefreshContext): Promise<ProviderModelConfig[]> {
    if (!context.allowNetwork) return this.#discovered.get(id) ?? listed;
    const catalog = customModelCatalog(runtime.getModels());
    const result = await discoverProviderModels({
      api: provider.api,
      baseUrl: provider.baseUrl,
      authentication: provider.apiKey ? "api_key" : "none",
      ...(provider.apiKey ? { apiKey: key } : {}),
    }, this.request, catalog);
    const models = new Map(listed.map((model) => [model.id, model]));
    for (const model of result.models) {
      // A plugin's provider is a chat provider: skip what only makes media,
      // and Google models it doesn't list as generating content.
      const usages = model.usages;
      if (provider.api === "google-generative-ai" ? !usages?.language : usages && !usages.language && Object.keys(usages).length) continue;
      // A list of ids alone, such as SiliconFlow's, also holds embedding, speech and image models.
      if (!usages?.language && namedNotForChat(model.id)) continue;
      // What the endpoint reports replaces a listed model's defaults; the plugin's title stays.
      models.set(model.id, {
        id: model.id, name: models.get(model.id)?.name ?? model.name, api: provider.api,
        reasoning: model.reasoning, input: model.supportsImages ? ["text", "image"] : ["text"],
        cost: ZERO_COST, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        ...thinkingLevels(model.thinkingLevelMap ?? model.reasoningCapabilities?.thinkingLevelMap ?? knownCustomModel(model.id, provider.api, catalog)?.thinkingLevelMap),
      });
    }
    const list = [...models.values()];
    // A list fetched with a key or package since replaced stays out of the cache.
    if (!context.signal.aborted && this.#registered.get(id) === signature) this.#discovered.set(id, list);
    return list;
  }
}

function chatModel(id: string, name: string, api: string, catalog: CustomModelCatalog): ProviderModelConfig {
  const known = knownCustomModel(id, api, catalog);
  return {
    id, name, api: api as ProviderConfig["api"],
    reasoning: known?.reasoning ?? false,
    input: known?.input.includes("image") ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow: known?.contextWindow ?? 128_000,
    maxTokens: Math.min(known?.contextWindow ?? 128_000, known?.maxTokens ?? 16_384),
    ...thinkingLevels(known?.thinkingLevelMap),
  };
}

/** Keeps the reasoning levels a known model allows, so none it refuses is offered. */
function thinkingLevels(map: unknown): { thinkingLevelMap?: ProviderChatModel["thinkingLevelMap"] } {
  return map && typeof map === "object" ? { thinkingLevelMap: map as ProviderChatModel["thinkingLevelMap"] } : {};
}

/**
 * The model runtime reads a key starting with `!` as a shell command and
 * `$NAME` as an environment variable. A key the person typed is neither.
 */
export function literalConfigValue(value: string): string {
  return value.replace(/\$/g, "$$$$").replace(/!/g, "$$!");
}
