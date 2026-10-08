import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { CUSTOM_MODEL_APIS, type CustomProviderSettings, type CustomProviderDetails, type CustomProviderModel, type CustomThinkingLevelMap, type SaveCustomProviderRequest, type ModelRef } from "../shared/contracts.js";
import type { RuntimeModel } from "./agent.js";
import { automaticCustomReasoning, normalizeThinkingLevelMap, resolveCustomModelCapabilities, type CustomModelCatalog } from "./custom-model-capabilities.js";
import { supportedReasoningLevels } from "../shared/reasoning.js";

type JsonObject = Record<string, unknown>;
type CustomProviderRegistry = Record<string, { authentication: "api_key" | "none"; reasoningCapabilities?: Record<string, CustomThinkingLevelMap> }>;

export class ProviderModelSettingsStore {
  readonly #preferencesPath: string;
  readonly #modelsPath: string;
  #hidden: Record<string, string[]> = {};
  #disabled: string[] = [];
  #customProviders: CustomProviderRegistry = {};
  #defaultImageModel?: ModelRef;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string, piAgentDirectory: string) {
    this.#preferencesPath = path.join(dataDirectory, "model-visibility.json");
    this.#modelsPath = path.join(piAgentDirectory, "models.json");
  }

  async load(): Promise<void> {
    const text = await readOptional(this.#preferencesPath);
    if (!text) return;
    const stored = JSON.parse(text) as { version?: unknown; hidden?: unknown; disabled?: unknown; customProviders?: unknown; defaultImageModel?: unknown };
    if (stored.version !== 1 || !isObject(stored.hidden) || Object.values(stored.hidden).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) throw new Error("Invalid model visibility settings");
    this.#hidden = stored.hidden as Record<string, string[]>;
    if (stored.disabled !== undefined && (!Array.isArray(stored.disabled) || stored.disabled.some((id) => typeof id !== "string"))) throw new Error("Invalid disabled providers");
    if (stored.customProviders !== undefined && (!isObject(stored.customProviders) || Object.values(stored.customProviders).some((item) => !isObject(item) || !["api_key", "none"].includes(String(item.authentication))))) throw new Error("Invalid custom providers");
    this.#disabled = (stored.disabled ?? []) as string[];
    this.#customProviders = (stored.customProviders ?? {}) as CustomProviderRegistry;
    for (const provider of Object.values(this.#customProviders)) {
      if (provider.reasoningCapabilities === undefined) continue;
      if (!isObject(provider.reasoningCapabilities)) throw new Error("Invalid provider reasoning capabilities");
      for (const capabilities of Object.values(provider.reasoningCapabilities)) normalizeThinkingLevelMap(capabilities);
    }
    if (stored.defaultImageModel !== undefined) {
      const model = stored.defaultImageModel;
      if (!isObject(model) || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) throw new Error("Invalid default image model");
      this.#defaultImageModel = { provider: model.provider, id: model.id };
    }
  }

  isEnabled(provider: string): boolean { return !this.#disabled.includes(provider); }
  isCustom(provider: string): boolean { return Object.hasOwn(this.#customProviders, provider); }

  resolveModel(model: RuntimeModel, catalog: CustomModelCatalog): RuntimeModel {
    return this.isCustom(model.provider) ? resolveCustomModelCapabilities(model, catalog, this.#customProviders[model.provider].reasoningCapabilities?.[model.id]) : model;
  }

  defaultImageModel(): ModelRef | undefined { return this.#defaultImageModel; }

  setDefaultImageModel(model: ModelRef): Promise<void> {
    const selected = { provider: model.provider, id: model.id };
    return this.#enqueue(async () => {
      await this.#writePreferences({ defaultImageModel: selected });
      this.#defaultImageModel = selected;
    });
  }

  async customProviders(): Promise<CustomProviderSettings[]> {
    if (!Object.keys(this.#customProviders).length) return [];
    const { config } = await this.#readModels();
    return Object.entries(this.#customProviders).map(([id, settings]) => {
      const entry = isObject(config.providers) ? config.providers[id] : undefined;
      if (!isObject(entry)) throw new Error("Custom provider configuration is missing");
      return { id, name: String(entry.name), api: String(entry.api), baseUrl: String(entry.baseUrl), authentication: settings.authentication };
    });
  }

  setEnabled(provider: string, enabled: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const disabled = new Set(this.#disabled);
      enabled ? disabled.delete(provider) : disabled.add(provider);
      await this.#writePreferences({ disabled: [...disabled] });
      this.#disabled = [...disabled];
    });
  }

  async customProvider(id: string, catalog: CustomModelCatalog = new Map()): Promise<CustomProviderDetails | undefined> {
    if (!this.isCustom(id)) return undefined;
    const { config } = await this.#readModels();
    const entry = isObject(config.providers) ? config.providers[id] : undefined;
    if (!isObject(entry)) throw new Error("Custom provider configuration is missing");
    const api = String(entry.api);
    const baseUrl = String(entry.baseUrl);
    const models = (Array.isArray(entry.models) ? entry.models.filter(isObject) : []).map((model) => {
      const reported = this.#customProviders[id].reasoningCapabilities?.[String(model.id)];
      return normalizeCustomProviderModel({ ...model, supportsImages: Array.isArray(model.input) && model.input.includes("image"), ...(reported ? { reasoningCapabilities: { source: "provider", thinkingLevelMap: reported } } : {}) }, api, baseUrl, catalog);
    });
    return {
      id, name: String(entry.name), api, baseUrl, authentication: this.#customProviders[id].authentication,
      models, hiddenModelIds: models.filter((model) => !this.isVisible({ provider: id, id: model.id })).map((model) => model.id),
    };
  }

  saveCustomProvider(id: string, settings: SaveCustomProviderRequest, apply: () => Promise<void>): Promise<void> {
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const existing = isObject(config.providers) ? config.providers[id] : undefined;
      if (existing !== undefined && !this.isCustom(id)) throw new Error("Only custom providers can be edited");
      // Edit individual fields so existing model definitions and JSONC comments survive.
      let contents = text;
      const fields: JsonObject = { name: settings.name, api: settings.api, baseUrl: settings.baseUrl };
      const models = settings.models ?? (!existing ? [] : undefined);
      if (models && (!isObject(existing) || !Array.isArray(existing.models) || !existing.models.length)) fields.models = models.map((model) => modelDefinition(model, settings.api, settings.baseUrl));
      for (const [key, value] of Object.entries(fields)) contents = applyEdits(contents, modify(contents, ["providers", id, key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      if (models && isObject(existing) && Array.isArray(existing.models) && existing.models.length) {
        const desired = new Map(models.map((model) => [model.id, modelDefinition(model, settings.api, settings.baseUrl)]));
        let index = 0;
        for (const previous of existing.models) {
          const definition = isObject(previous) ? desired.get(String(previous.id)) : undefined;
          if (!definition) {
            contents = applyEdits(contents, modify(contents, ["providers", id, "models", index], undefined, {}));
            continue;
          }
          // Preserve model comments, pricing and provider-specific fields while editing supported settings.
          for (const key of ["name", "api", "baseUrl", "contextWindow", "maxTokens", "reasoning", "thinkingLevelMap", "input"]) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(definition[key])) contents = applyEdits(contents, modify(contents, ["providers", id, "models", index, key], definition[key], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
          }
          desired.delete(String(previous.id));
          index += 1;
        }
        for (const definition of desired.values()) {
          contents = applyEdits(contents, modify(contents, ["providers", id, "models", index++], definition, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
        }
      }
      const reported = models ? Object.fromEntries(models.filter((model) => model.reasoningCapabilities?.source === "provider").map((model) => [model.id, model.reasoningCapabilities!.thinkingLevelMap]))
        : isObject(existing) && existing.api === settings.api && existing.baseUrl === settings.baseUrl ? this.#customProviders[id]?.reasoningCapabilities : undefined;
      const customProviders = { ...this.#customProviders, [id]: { authentication: settings.authentication, ...(reported && Object.keys(reported).length ? { reasoningCapabilities: reported } : {}) } };
      const hidden = { ...this.#hidden };
      if (models) {
        const ids = new Set(models.map((model) => model.id));
        hidden[id] = (settings.hiddenModelIds ?? hidden[id] ?? []).filter((modelId) => ids.has(modelId));
      }
      const oldPreferences = this.#preferences();
      try {
        await writeAtomic(this.#modelsPath, contents);
        await this.#writePreferences({ customProviders, hidden });
        await apply();
        this.#customProviders = customProviders;
        this.#hidden = hidden;
      } catch (cause) {
        await writeAtomic(this.#modelsPath, text);
        await writeAtomic(this.#preferencesPath, oldPreferences);
        throw cause;
      }
    });
  }

  removeCustomProvider(id: string, apply: () => Promise<void>): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.isCustom(id)) throw new Error("Only custom providers can be removed");
      const { text } = await this.#readModels();
      const contents = applyEdits(text, modify(text, ["providers", id], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      const customProviders = { ...this.#customProviders };
      const hidden = { ...this.#hidden };
      delete customProviders[id];
      delete hidden[id];
      const disabled = this.#disabled.filter((provider) => provider !== id);
      const defaultImageModel = this.#defaultImageModel?.provider === id ? undefined : this.#defaultImageModel;
      const oldPreferences = this.#preferences();
      try {
        await writeAtomic(this.#modelsPath, contents);
        await this.#writePreferences({ customProviders, hidden, disabled, defaultImageModel });
        await apply();
        this.#customProviders = customProviders;
        this.#hidden = hidden;
        this.#disabled = disabled;
        this.#defaultImageModel = defaultImageModel;
      } catch (cause) {
        await writeAtomic(this.#modelsPath, text);
        await writeAtomic(this.#preferencesPath, oldPreferences);
        throw cause;
      }
    });
  }

  #preferences(overrides: JsonObject = {}): string {
    return `${JSON.stringify({ version: 1, hidden: this.#hidden, disabled: this.#disabled, customProviders: this.#customProviders, defaultImageModel: this.#defaultImageModel, ...overrides }, null, 2)}\n`;
  }

  #writePreferences(overrides: JsonObject): Promise<void> {
    return writeAtomic(this.#preferencesPath, this.#preferences(overrides));
  }

  isVisible(model: ModelRef): boolean {
    const hidden = this.#hidden[model.provider];
    return !Array.isArray(hidden) || !hidden.includes(model.id);
  }

  setVisibility(provider: string, ids: string[], visible: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const hidden = new Set(Array.isArray(this.#hidden[provider]) ? this.#hidden[provider] : []);
      for (const id of ids) visible ? hidden.delete(id) : hidden.add(id);
      const next = { ...this.#hidden, [provider]: [...hidden] };
      await this.#writePreferences({ hidden: next });
      this.#hidden = next;
    });
  }

  async customModels(provider: string): Promise<JsonObject[]> {
    const { config } = await this.#readModels();
    const entry = isObject(config.providers) ? config.providers[provider] : undefined;
    return isObject(entry) && Array.isArray(entry.models) ? entry.models.filter(isObject) : [];
  }

  addCustomModel(provider: string, model: CustomProviderModel): Promise<void> {
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const entry = isObject(config.providers) ? config.providers[provider] : undefined;
      const models = isObject(entry) && Array.isArray(entry.models) ? entry.models : [];
      if (models.some((item) => isObject(item) && item.id === model.id)) throw new Error("A model with this ID already exists");
      const definition = modelDefinition(model, this.isCustom(provider) && isObject(entry) ? String(entry.api) : undefined, this.isCustom(provider) && isObject(entry) ? String(entry.baseUrl) : undefined);
      const contents = applyEdits(text, modify(text, ["providers", provider, "models"], [...models, definition], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await writeAtomic(this.#modelsPath, contents);
    });
  }

  removeCustomModel(provider: string, id: string): Promise<void> {
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const entry = isObject(config.providers) ? config.providers[provider] : undefined;
      const models = isObject(entry) && Array.isArray(entry.models) ? entry.models : [];
      const index = models.findIndex((item) => isObject(item) && item.id === id);
      if (index < 0) throw new Error("Custom model not found");
      const contents = applyEdits(text, modify(text, ["providers", provider, "models", index], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await writeAtomic(this.#modelsPath, contents);
    });
  }

  async #readModels(): Promise<{ text: string; config: JsonObject }> {
    const text = await readOptional(this.#modelsPath) ?? "{}\n";
    const errors: ParseError[] = [];
    const config: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !isObject(config) || (config.providers !== undefined && !isObject(config.providers))) throw new Error("Invalid models.json; fix it before editing models");
    return { text, config };
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }
}

function modelDefinition(model: CustomProviderModel, inheritedApi?: string, inheritedBaseUrl?: string): JsonObject {
  return {
    id: model.id, name: model.name,
    ...(model.api !== inheritedApi ? { api: model.api } : {}),
    ...(model.baseUrl && model.baseUrl !== inheritedBaseUrl ? { baseUrl: model.baseUrl } : {}),
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    reasoning: model.reasoning, input: model.supportsImages ? ["text", "image"] : ["text"],
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function normalizeCustomProvider(value: unknown, catalog: CustomModelCatalog = new Map()): SaveCustomProviderRequest {
  if (!isObject(value)) throw new Error("Invalid custom provider");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new Error("Provider name is required (up to 100 characters)");
  const api = typeof value.api === "string" ? value.api : "";
  if (!CUSTOM_MODEL_APIS.some((known) => known === api)) throw new Error("Unsupported provider API");
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/+$/, "") : "";
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("Invalid provider Base URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Base URL must be an HTTP(S) URL without credentials, query or fragment");
  if (value.authentication !== "api_key" && value.authentication !== "none") throw new Error("Invalid authentication method");
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : undefined;
  if (apiKey && /[^\x20-\x7e]/.test(apiKey)) throw new Error("API key must contain printable ASCII characters");
  let models: CustomProviderModel[] | undefined;
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length > 2_000) throw new Error("Provide up to 2,000 models");
    models = value.models.map((model) => normalizeCustomProviderModel(model, api, baseUrl, catalog));
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("Model IDs must be unique");
  }
  let hiddenModelIds: string[] | undefined;
  if (value.hiddenModelIds !== undefined) {
    const ids = new Set(models?.map((model) => model.id));
    if (!models || !Array.isArray(value.hiddenModelIds) || value.hiddenModelIds.length > models.length || value.hiddenModelIds.some((id) => typeof id !== "string" || !ids.has(id))) throw new Error("Hidden model IDs must belong to the submitted model list");
    hiddenModelIds = [...new Set(value.hiddenModelIds as string[])];
  }
  return { name, api, baseUrl, authentication: value.authentication, ...(apiKey ? { apiKey } : {}), ...(models ? { models } : {}), ...(hiddenModelIds ? { hiddenModelIds } : {}) };
}

export function normalizeCustomProviderModel(value: unknown, defaultApi: string, defaultBaseUrl?: string, catalog: CustomModelCatalog = new Map()): CustomProviderModel {
  if (!isObject(value)) throw new Error("Invalid custom model");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || !name || name.length > 200) throw new Error("Model ID and name are required (up to 200 characters)");
  const api = typeof value.api === "string" ? value.api : defaultApi;
  if (api !== defaultApi && !CUSTOM_MODEL_APIS.some((known) => known === api)) throw new Error("Unsupported model API");
  const contextWindow = value.contextWindow;
  const maxTokens = value.maxTokens;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 100_000_000 || typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("Token limits must be positive integers, with output tokens no greater than context size");
  if (typeof value.reasoning !== "boolean" || typeof value.supportsImages !== "boolean") throw new Error("Invalid model capabilities");
  const thinkingLevelMap = normalizeThinkingLevelMap(value.thinkingLevelMap);
  const detected = value.reasoningCapabilities;
  if (detected !== undefined && (!isObject(detected) || !["provider", "catalog"].includes(String(detected.source)) || detected.thinkingLevelMap === undefined)) throw new Error("Invalid reasoning capabilities");
  const reported = isObject(detected) && detected.source === "provider" ? normalizeThinkingLevelMap(detected.thinkingLevelMap) : undefined;
  const reasoningCapabilities = automaticCustomReasoning(id, api, catalog, reported);
  if (!supportedReasoningLevels({ reasoning: value.reasoning, thinkingLevelMap: { ...reasoningCapabilities?.thinkingLevelMap, ...thinkingLevelMap } }).length) throw new Error("Enable at least one reasoning level");
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : undefined;
  if (!baseUrl && !defaultBaseUrl) throw new Error("Model Base URL is required for this provider");
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("Invalid model Base URL"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid model Base URL");
  }
  return { id, name, api, ...(baseUrl ? { baseUrl: baseUrl.replace(/\/$/, "") } : {}), contextWindow, maxTokens, reasoning: value.reasoning, ...(thinkingLevelMap ? { thinkingLevelMap } : {}), ...(reasoningCapabilities ? { reasoningCapabilities } : {}), supportsImages: value.supportsImages };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try { return await readFile(filePath, "utf8"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; return undefined; }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }); }
}
