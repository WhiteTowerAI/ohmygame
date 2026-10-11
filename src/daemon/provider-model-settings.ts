import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, format, modify, parse, type JSONPath, type ParseError } from "jsonc-parser";
import { CUSTOM_MODEL_APIS, type CustomProviderSettings, type CustomProviderDetails, type CustomProviderModel, type CustomThinkingLevelMap, type SaveCustomProviderRequest, type ModelRef, type ImageModel, type ProviderCapability, type Model3DDefinition } from "../shared/contracts.js";
import { isNative3DProvider, MODEL_3D_PRESETS, model3DPreset, normalizeNativeModel3D, type Native3DProviderId } from "../shared/model3d-presets.js";
import { modelUsageList, modelUsages, normalizeEndpoint, normalizeModelUsages } from "../shared/custom-models.js";
import type { RuntimeModel } from "./agent.js";
import { automaticCustomReasoning, normalizeThinkingLevelMap, resolveCustomModelCapabilities, type CustomModelCatalog } from "./custom-model-capabilities.js";
import { supportedReasoningLevels } from "../shared/reasoning.js";

type JsonObject = Record<string, unknown>;
type CustomProviderRegistry = Record<string, {
  authentication: "api_key" | "none"; reasoningCapabilities?: Record<string, CustomThinkingLevelMap>;
  preset?: CustomProviderSettings["preset"]; modelConfigurationVersion?: 2; models?: CustomProviderModel[];
}>;

export class ProviderModelSettingsStore {
  readonly #preferencesPath: string;
  readonly #modelsPath: string;
  #hidden: Record<string, string[]> = {};
  #disabled: string[] = [];
  #customProviders: CustomProviderRegistry = {};
  #nativeModels3D: Partial<Record<Native3DProviderId, Model3DDefinition[]>> = {};
  #defaultImageModel?: ModelRef;
  #defaultVideoModel?: ModelRef;
  #defaultModel3D?: ModelRef;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string, piAgentDirectory: string) {
    this.#preferencesPath = path.join(dataDirectory, "model-visibility.json");
    this.#modelsPath = path.join(piAgentDirectory, "models.json");
  }

  async load(): Promise<void> {
    const text = await readOptional(this.#preferencesPath);
    if (!text) return;
    const stored = JSON.parse(text) as { version?: unknown; hidden?: unknown; disabled?: unknown; customProviders?: unknown; nativeModels3D?: unknown; defaultImageModel?: unknown; defaultVideoModel?: unknown; defaultModel3D?: unknown };
    if (stored.version !== 1 || !isObject(stored.hidden) || Object.values(stored.hidden).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) throw new Error("Invalid model visibility settings");
    this.#hidden = stored.hidden as Record<string, string[]>;
    if (stored.disabled !== undefined && (!Array.isArray(stored.disabled) || stored.disabled.some((id) => typeof id !== "string"))) throw new Error("Invalid disabled providers");
    if (stored.customProviders !== undefined && (!isObject(stored.customProviders) || Object.values(stored.customProviders).some((item) => !isObject(item) || !["api_key", "none"].includes(String(item.authentication))))) throw new Error("Invalid custom providers");
    this.#disabled = (stored.disabled ?? []) as string[];
    this.#customProviders = (stored.customProviders ?? {}) as CustomProviderRegistry;
    if (stored.nativeModels3D !== undefined) {
      if (!isObject(stored.nativeModels3D)) throw new Error("Invalid native 3D models");
      for (const [provider, entries] of Object.entries(stored.nativeModels3D)) {
        if (!isNative3DProvider(provider) || !Array.isArray(entries) || entries.length > 2_000) throw new Error("Invalid native 3D models");
        const models = entries.map((entry) => normalizeNativeModel3D(provider, entry, "restore"));
        if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("Duplicate 3D model IDs");
        this.#nativeModels3D[provider] = models;
      }
    }
    for (const provider of Object.values(this.#customProviders)) {
      if (provider.reasoningCapabilities === undefined) continue;
      if (!isObject(provider.reasoningCapabilities)) throw new Error("Invalid provider reasoning capabilities");
      for (const capabilities of Object.values(provider.reasoningCapabilities)) normalizeThinkingLevelMap(capabilities);
    }
    for (const key of ["defaultImageModel", "defaultVideoModel", "defaultModel3D"] as const) {
      const model = stored[key];
      if (model === undefined) continue;
      if (!isObject(model) || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) throw new Error("Invalid default media model");
      if (key === "defaultImageModel") this.#defaultImageModel = { provider: model.provider, id: model.id };
      else if (key === "defaultVideoModel") this.#defaultVideoModel = { provider: model.provider, id: model.id };
      else this.#defaultModel3D = { provider: model.provider, id: model.id };
    }
  }

  isEnabled(provider: string): boolean { return !this.#disabled.includes(provider); }
  isCustom(provider: string): boolean { return Object.hasOwn(this.#customProviders, provider); }

  models3D(provider: Native3DProviderId): Model3DDefinition[] {
    return [...new Map([...MODEL_3D_PRESETS[provider], ...(this.#nativeModels3D[provider] ?? [])].map((model) => [model.id, model])).values()];
  }

  saveModel3D(provider: Native3DProviderId, value: unknown, create = false): Promise<void> {
    const model = normalizeNativeModel3D(provider, value);
    return this.#enqueue(async () => {
      const exists = this.models3D(provider).some((entry) => entry.id === model.id);
      if (create && exists) throw new Error("A model with this ID already exists");
      if (!create && !exists) throw new Error("3D model not found");
      const entries = this.#nativeModels3D[provider] ?? [];
      if (create && entries.length >= 2_000) throw new Error("Provide up to 2,000 models");
      const nativeModels3D = { ...this.#nativeModels3D, [provider]: [...entries.filter((entry) => entry.id !== model.id), model] };
      const hidden = create ? { ...this.#hidden, [provider]: (this.#hidden[provider] ?? []).filter((id) => id !== model.id) } : this.#hidden;
      await this.#writePreferences({ nativeModels3D, hidden });
      this.#nativeModels3D = nativeModels3D;
      this.#hidden = hidden;
    });
  }

  removeModel3D(provider: Native3DProviderId, id: string, reset = false): Promise<void> {
    return this.#enqueue(async () => {
      const preset = model3DPreset(provider, id);
      if (reset ? !preset : preset || !this.models3D(provider).some((model) => model.id === id)) throw new Error(reset ? "Official model not found" : "Only custom versions can be deleted");
      const nativeModels3D = { ...this.#nativeModels3D, [provider]: (this.#nativeModels3D[provider] ?? []).filter((model) => model.id !== id) };
      const hidden = reset ? this.#hidden : { ...this.#hidden, [provider]: (this.#hidden[provider] ?? []).filter((modelId) => modelId !== id) };
      await this.#writePreferences({ nativeModels3D, hidden });
      this.#nativeModels3D = nativeModels3D;
      this.#hidden = hidden;
    });
  }

  resolveModel(model: RuntimeModel, catalog: CustomModelCatalog): RuntimeModel {
    return this.isCustom(model.provider) ? resolveCustomModelCapabilities(model, catalog, this.#customProviders[model.provider].reasoningCapabilities?.[model.id]) : model;
  }

  defaultImageModel(): ModelRef | undefined { return this.#defaultImageModel; }
  defaultVideoModel(): ModelRef | undefined { return this.#defaultVideoModel; }
  defaultModel3D(): ModelRef | undefined { return this.#defaultModel3D; }

  setDefaultMediaModel(usage: Exclude<ProviderCapability, "language">, model?: ModelRef): Promise<void> {
    const key = usage === "image" ? "defaultImageModel" : usage === "video" ? "defaultVideoModel" : "defaultModel3D";
    const selected = model ? { provider: model.provider, id: model.id } : undefined;
    return this.#enqueue(async () => {
      await this.#writePreferences({ [key]: selected });
      if (usage === "image") this.#defaultImageModel = selected;
      else if (usage === "video") this.#defaultVideoModel = selected;
      else this.#defaultModel3D = selected;
    });
  }

  setDefaultImageModel(model?: ModelRef): Promise<void> {
    return this.setDefaultMediaModel("image", model);
  }

  setEnabled(provider: string | readonly string[], enabled: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const disabled = new Set(this.#disabled);
      for (const id of typeof provider === "string" ? [provider] : provider) enabled ? disabled.delete(id) : disabled.add(id);
      await this.#writePreferences({ disabled: [...disabled] });
      this.#disabled = [...disabled];
    });
  }

  async customProvider(id: string, catalog: CustomModelCatalog = new Map()): Promise<CustomProviderDetails | undefined> {
    if (!this.isCustom(id)) return undefined;
    const { config } = await this.#readModels();
    return this.#customProvider(id, config, catalog);
  }

  async customProviderCatalog(): Promise<CustomProviderDetails[]> {
    if (!Object.keys(this.#customProviders).length) return [];
    const { config } = await this.#readModels();
    const catalog: CustomModelCatalog = new Map();
    return Object.keys(this.#customProviders).map((id) => this.#customProvider(id, config, catalog));
  }

  #customProvider(id: string, config: JsonObject, catalog: CustomModelCatalog): CustomProviderDetails {
    const entry = isObject(config.providers) ? config.providers[id] : undefined;
    if (!isObject(entry)) throw new Error("Custom provider configuration is missing");
    const api = String(entry.api);
    const baseUrl = String(entry.baseUrl);
    const registry = this.#customProviders[id];
    const models = (registry.models ?? (Array.isArray(entry.models) ? entry.models.filter(isObject) : [])).map((model) => {
      const reported = registry.reasoningCapabilities?.[String(model.id)];
      return normalizeCustomProviderModel({ ...model, supportsImages: "supportsImages" in model ? model.supportsImages : Array.isArray(model.input) && model.input.includes("image"), ...(reported ? { reasoningCapabilities: { source: "provider", thinkingLevelMap: reported } } : {}) }, api, baseUrl, catalog);
    });
    return {
      id, name: String(entry.name), api, baseUrl, authentication: registry.authentication,
      ...(registry.preset ? { preset: registry.preset } : {}), ...(registry.modelConfigurationVersion ? { modelConfigurationVersion: registry.modelConfigurationVersion } : {}),
      models, hiddenModelIds: models.filter((model) => !this.isVisible({ provider: id, id: model.id })).map((model) => model.id),
    };
  }

  /** Import the models the previous version already exposed once, then honour the saved choices. */
  async migrateLegacyImageModels(id: string, images: ImageModel[], apply: () => Promise<void>): Promise<void> {
    const current = await this.customProvider(id);
    if (!current || current.modelConfigurationVersion === 2) return;
    const models = new Map(current.models.map((model) => [model.id, { ...model, usages: modelUsages(model) }]));
    for (const image of images) {
      const previous = models.get(image.id);
      models.set(image.id, { ...(previous ?? { id: image.id, name: image.name, api: current.api, contextWindow: 128_000, maxTokens: 16_384, reasoning: false, supportsImages: false }),
        usages: { ...previous?.usages, image: { protocol: image.protocol,
          resolutions: [...new Set(image.generationOptions.map((option) => option.resolution))],
          aspectRatios: [...new Set(image.generationOptions.map((option) => option.aspectRatio))],
          maxReferenceImages: image.supportsReferenceImage ? Math.min(14, image.maxReferenceImages ?? 1) : 0, maxOutputs: image.maxOutputs } } });
    }
    await this.saveCustomProvider(id, { ...current, modelConfigurationVersion: 2, models: [...models.values()] }, apply, true);
  }

  saveCustomProvider(id: string, settings: SaveCustomProviderRequest, apply: () => Promise<void>, onlyLegacy = false): Promise<void> {
    return this.#enqueue(async () => {
      if (onlyLegacy && this.#customProviders[id]?.modelConfigurationVersion === 2) return;
      const { text, config } = await this.#readModels();
      const existing = isObject(config.providers) ? config.providers[id] : undefined;
      if (existing !== undefined && !this.isCustom(id)) throw new Error("Only custom providers can be edited");
      const name = customProviderNameKey(settings.name);
      if (!isObject(existing) || customProviderNameKey(String(existing.name)) !== name) {
        const duplicate = Object.keys(this.#customProviders).some((otherId) => {
          const other = isObject(config.providers) ? config.providers[otherId] : undefined;
          return otherId !== id && isObject(other) && customProviderNameKey(String(other.name)) === name;
        });
        if (duplicate) throw new Error("A custom provider with this name already exists. Choose a different display name.");
      }
      // Edit individual fields so existing model definitions and JSONC comments survive.
      let contents = text;
      const fields: JsonObject = { name: settings.name, api: settings.api, baseUrl: settings.baseUrl };
      const models = settings.models ?? (!existing ? [] : undefined);
      const languageModels = models?.filter((model) => modelUsages(model).language);
      if (languageModels && (!isObject(existing) || !Array.isArray(existing.models) || !existing.models.length)) fields.models = languageModels.map((model) => modelDefinition(model, settings.api, settings.baseUrl));
      for (const [key, value] of Object.entries(fields)) contents = modifyFormattedJsonc(contents, ["providers", id, key], value);
      if (languageModels && isObject(existing) && Array.isArray(existing.models) && existing.models.length) {
        const desired = new Map(languageModels.map((model) => [model.id, modelDefinition(model, settings.api, settings.baseUrl)]));
        let index = 0;
        for (const previous of existing.models) {
          const definition = isObject(previous) ? desired.get(String(previous.id)) : undefined;
          if (!definition) {
            contents = applyEdits(contents, modify(contents, ["providers", id, "models", index], undefined, {}));
            continue;
          }
          // Preserve model comments, pricing and provider-specific fields while editing supported settings.
          for (const key of ["name", "api", "baseUrl", "contextWindow", "maxTokens", "reasoning", "thinkingLevelMap", "input"]) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(definition[key])) contents = modifyFormattedJsonc(contents, ["providers", id, "models", index, key], definition[key]);
          }
          desired.delete(String(previous.id));
          index += 1;
        }
        for (const definition of desired.values()) {
          contents = modifyFormattedJsonc(contents, ["providers", id, "models", index++], definition);
        }
      }
      const reported = models ? Object.fromEntries(models.filter((model) => model.reasoningCapabilities?.source === "provider").map((model) => [model.id, model.reasoningCapabilities!.thinkingLevelMap]))
        : isObject(existing) && existing.api === settings.api && existing.baseUrl === settings.baseUrl ? this.#customProviders[id]?.reasoningCapabilities : undefined;
      const savedModels = models?.map(({ reasoningCapabilities: _, ...model }) => ({ ...model,
        ...(model.baseUrl === settings.baseUrl ? { baseUrl: undefined } : {}) }))
        ?? this.#customProviders[id]?.models?.map((model) => ({ ...model, api: isObject(existing) && model.api === existing.api ? settings.api : model.api }));
      const modelConfigurationVersion = settings.modelConfigurationVersion ?? this.#customProviders[id]?.modelConfigurationVersion;
      const customProviders = { ...this.#customProviders, [id]: { authentication: settings.authentication,
        ...(settings.preset ? { preset: settings.preset } : {}), ...(modelConfigurationVersion ? { modelConfigurationVersion } : {}),
        ...(savedModels ? { models: savedModels } : {}), ...(reported && Object.keys(reported).length ? { reasoningCapabilities: reported } : {}) } };
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

  removeProviderSettings(id: string, apply: () => Promise<void>): Promise<void> {
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const contents = isObject(config.providers) && Object.hasOwn(config.providers, id)
        ? modifyFormattedJsonc(text, ["providers", id], undefined) : text;
      const customProviders = { ...this.#customProviders };
      const nativeModels3D = { ...this.#nativeModels3D };
      const hidden = { ...this.#hidden };
      delete customProviders[id];
      delete hidden[id];
      if (isNative3DProvider(id)) delete nativeModels3D[id];
      const disabled = this.#disabled.filter((provider) => provider !== id);
      const defaultImageModel = this.#defaultImageModel?.provider === id ? undefined : this.#defaultImageModel;
      const defaultVideoModel = this.#defaultVideoModel?.provider === id ? undefined : this.#defaultVideoModel;
      const defaultModel3D = this.#defaultModel3D?.provider === id ? undefined : this.#defaultModel3D;
      const oldPreferences = this.#preferences();
      try {
        if (contents !== text) await writeAtomic(this.#modelsPath, contents);
        await this.#writePreferences({ customProviders, nativeModels3D, hidden, disabled, defaultImageModel, defaultVideoModel, defaultModel3D });
        await apply();
        this.#customProviders = customProviders;
        this.#nativeModels3D = nativeModels3D;
        this.#hidden = hidden;
        this.#disabled = disabled;
        this.#defaultImageModel = defaultImageModel;
        this.#defaultVideoModel = defaultVideoModel;
        this.#defaultModel3D = defaultModel3D;
      } catch (cause) {
        if (contents !== text) await writeAtomic(this.#modelsPath, text);
        await writeAtomic(this.#preferencesPath, oldPreferences);
        throw cause;
      }
    });
  }

  #preferences(overrides: JsonObject = {}): string {
    return `${JSON.stringify({ version: 1, hidden: this.#hidden, disabled: this.#disabled, customProviders: this.#customProviders, nativeModels3D: this.#nativeModels3D, defaultImageModel: this.#defaultImageModel, defaultVideoModel: this.#defaultVideoModel, defaultModel3D: this.#defaultModel3D, ...overrides }, null, 2)}\n`;
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

  async addCustomModel(provider: string, model: CustomProviderModel): Promise<void> {
    if (this.isCustom(provider)) {
      const settings = (await this.customProvider(provider))!;
      if (settings.models.some((item) => item.id === model.id)) throw new Error("A model with this ID already exists");
      return this.saveCustomProvider(provider, { ...settings, models: [...settings.models, model] }, async () => {});
    }
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const entry = isObject(config.providers) ? config.providers[provider] : undefined;
      const models = isObject(entry) && Array.isArray(entry.models) ? entry.models : [];
      if (models.some((item) => isObject(item) && item.id === model.id)) throw new Error("A model with this ID already exists");
      const definition = modelDefinition(model, this.isCustom(provider) && isObject(entry) ? String(entry.api) : undefined, this.isCustom(provider) && isObject(entry) ? String(entry.baseUrl) : undefined);
      const contents = modifyFormattedJsonc(text, ["providers", provider, "models"], [...models, definition]);
      await writeAtomic(this.#modelsPath, contents);
    });
  }

  async removeCustomModel(provider: string, id: string): Promise<void> {
    if (this.isCustom(provider)) {
      const settings = (await this.customProvider(provider))!;
      if (!settings.models.some((model) => model.id === id)) throw new Error("Custom model not found");
      return this.saveCustomProvider(provider, { ...settings, models: settings.models.filter((model) => model.id !== id),
        hiddenModelIds: settings.hiddenModelIds.filter((modelId) => modelId !== id) }, async () => {});
    }
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const entry = isObject(config.providers) ? config.providers[provider] : undefined;
      const models = isObject(entry) && Array.isArray(entry.models) ? entry.models : [];
      const index = models.findIndex((item) => isObject(item) && item.id === id);
      if (index < 0) throw new Error("Custom model not found");
      const contents = modifyFormattedJsonc(text, ["providers", provider, "models", index], undefined);
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

function modifyFormattedJsonc(text: string, jsonPath: JSONPath, value: unknown): string {
  const edit = modify(text, jsonPath, value, {})[0];
  if (!edit) return text;
  const contents = applyEdits(text, [edit]);
  let begin = edit.offset;
  let end = begin + edit.content.length;
  if (!edit.length || !edit.content.length) {
    while (begin > 0 && !/[\r\n]/.test(contents[begin - 1])) begin--;
    while (end < contents.length && !/[\r\n]/.test(contents[end])) end++;
  }
  // jsonc-parser's formatted modify copies the entire document for each whitespace
  // edit. Join the ordered formatting edits once to keep large model lists linear.
  const parts: string[] = [];
  let cursor = 0;
  for (const formatting of format(contents, { offset: begin, length: end - begin }, { insertSpaces: true, tabSize: 2, keepLines: false })) {
    parts.push(contents.slice(cursor, formatting.offset), formatting.content);
    cursor = formatting.offset + formatting.length;
  }
  parts.push(contents.slice(cursor));
  return parts.join("");
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
  const baseUrl = normalizeEndpoint(value.baseUrl);
  if (value.authentication !== "api_key" && value.authentication !== "none") throw new Error("Invalid authentication method");
  if (value.preset !== undefined && !["gateway", "ollama", "lmstudio", "google", "openrouter", "seedance", "meshy", "tripo", "hyper3d"].includes(String(value.preset))) throw new Error("Invalid provider preset");
  if (value.modelConfigurationVersion !== undefined && value.modelConfigurationVersion !== 2) throw new Error("Unsupported model configuration version");
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
  const modelConfigurationVersion = value.modelConfigurationVersion === 2 || models?.some((model) => model.usages !== undefined) ? 2 : undefined;
  if (modelConfigurationVersion === 2 && models?.some((model) => !hiddenModelIds?.includes(model.id) && !modelUsageList(model).length)) throw new Error("Assign a use to each enabled model");
  return { name, api, baseUrl, authentication: value.authentication, ...(value.preset ? { preset: value.preset as CustomProviderSettings["preset"] } : {}),
    ...(modelConfigurationVersion ? { modelConfigurationVersion } : {}), ...(apiKey ? { apiKey } : {}), ...(models ? { models } : {}), ...(hiddenModelIds ? { hiddenModelIds } : {}) };
}

export function normalizeCustomProviderModel(value: unknown, defaultApi: string, defaultBaseUrl?: string, catalog: CustomModelCatalog = new Map()): CustomProviderModel {
  if (!isObject(value)) throw new Error("Invalid custom model");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || !name || name.length > 200) throw new Error("Model ID and name are required (up to 200 characters)");
  const api = typeof value.api === "string" ? value.api : defaultApi;
  if (api !== defaultApi && !CUSTOM_MODEL_APIS.some((known) => known === api)) throw new Error("Unsupported model API");
  const usages = normalizeModelUsages(value.usages);
  const language = usages === undefined || Boolean(usages.language);
  const contextWindow = language ? value.contextWindow : typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0 && value.contextWindow <= 100_000_000 ? value.contextWindow : 128_000;
  const maxTokens = language ? value.maxTokens : typeof value.maxTokens === "number" && Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 && value.maxTokens <= Number(contextWindow) ? value.maxTokens : Math.min(16_384, Number(contextWindow));
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 100_000_000 || typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("Token limits must be positive integers, with output tokens no greater than context size");
  if (language && (typeof value.reasoning !== "boolean" || typeof value.supportsImages !== "boolean")) throw new Error("Invalid model capabilities");
  const reasoning = value.reasoning === true;
  const supportsImages = value.supportsImages === true;
  const thinkingLevelMap = normalizeThinkingLevelMap(value.thinkingLevelMap);
  const detected = language ? value.reasoningCapabilities : undefined;
  if (detected !== undefined && (!isObject(detected) || !["provider", "catalog"].includes(String(detected.source)) || detected.thinkingLevelMap === undefined)) throw new Error("Invalid reasoning capabilities");
  const reported = isObject(detected) && detected.source === "provider" ? normalizeThinkingLevelMap(detected.thinkingLevelMap) : undefined;
  const reasoningCapabilities = language ? automaticCustomReasoning(id, api, catalog, reported) : undefined;
  if (!supportedReasoningLevels({ reasoning, thinkingLevelMap: { ...reasoningCapabilities?.thinkingLevelMap, ...thinkingLevelMap } }).length) throw new Error("Enable at least one reasoning level");
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? normalizeEndpoint(value.baseUrl) : undefined;
  if (!baseUrl && !defaultBaseUrl) throw new Error("Model Base URL is required for this provider");
  return { id, name, api, ...(baseUrl ? { baseUrl } : {}), contextWindow, maxTokens, reasoning, ...(thinkingLevelMap ? { thinkingLevelMap } : {}), ...(reasoningCapabilities ? { reasoningCapabilities } : {}), supportsImages, ...(usages ? { usages } : {}) };
}

function customProviderNameKey(name: string): string { return name.trim().toLowerCase(); }

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
