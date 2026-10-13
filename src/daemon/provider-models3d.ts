import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomModel3DSettings, CustomProviderDetails, MediaModelCatalog, Model3DDefinition, Model3DModel, Model3DModelRef, Model3DOperation, Model3DOptions } from "../shared/contracts.js";
import { customModel3D, model3DModel } from "../shared/custom-models.js";
import { resolveModel3D, resolveModel3DConnection } from "../shared/generation-config.js";
import { isNative3DProvider, MODEL_3D_PRESETS, NATIVE_3D_PROVIDER_NAMES, type Native3DProviderId } from "../shared/model3d-presets.js";
import { MODEL3D_CONNECTION_ID } from "../shared/model3d-operations.js";
import { customMediaSource } from "./custom-media-source.js";
import { TripoProvider } from "./tripo-provider.js";
import { MeshyProvider } from "./meshy-provider.js";
import { Hyper3DProvider } from "./hyper3d-provider.js";
import { Model3DGenerationError, type Model3DGenerator, type Model3DGenerationInput, type Model3DAnimationInput } from "./model3d.js";
import type { CloudModelsClient } from "./cloud-models.js";

const PROVIDERS = { tripo: TripoProvider, meshy: MeshyProvider, hyper3d: Hyper3DProvider };
type Connection = MeshyProvider | TripoProvider | Hyper3DProvider;

interface ProviderModels3DOptions {
  runtime: () => Promise<ModelRuntime>;
  meshy: { generator: MeshyProvider; configured: () => boolean };
  tripo?: { generator: TripoProvider; configured: () => boolean };
  hyper3d?: { generator: Hyper3DProvider; configured: () => boolean };
  customProviders: () => Promise<CustomProviderDetails[]>;
  nativeModels: (provider: Native3DProviderId) => Model3DDefinition[];
  isEnabled: (provider: string) => boolean;
  isVisible: (model: Model3DModelRef) => boolean;
  request?: typeof fetch;
  defaultModel: () => Model3DModelRef | undefined;
  cloud?: CloudModelsClient;
}

export class ProviderModels3D implements Model3DGenerator {
  readonly #customConnections = new Map<string, { fingerprint: string; generator: Connection }>();
  constructor(private readonly options: ProviderModels3DOptions) {}

  async catalog(): Promise<MediaModelCatalog<Model3DModel>> {
    const models: Model3DModel[] = [];
    const providers: MediaModelCatalog<Model3DModel>["providers"] = [];
    for (const provider of Object.keys(NATIVE_3D_PROVIDER_NAMES) as Native3DProviderId[]) {
      if (!this.options[provider]?.configured() || !this.options.isEnabled(provider)) continue;
      const configured = this.nativeModels(provider);
      models.push(...configured);
      providers.push({ provider, providerName: provider === "hyper3d" ? "Hyper3D · API key" : NATIVE_3D_PROVIDER_NAMES[provider], state: configured.length ? "ready" : "empty", ...(!configured.length ? { message: "Enable 3D models in Models." } : {}) });
    }
    for (const provider of await this.options.customProviders()) {
      if (!this.options.isEnabled(provider.id) || !provider.models.some((model) => model.usages?.["3d"]) || !(await this.options.runtime()).hasConfiguredAuth(provider.id)) continue;
      const configured = provider.models.filter((model) => !provider.hiddenModelIds.includes(model.id)).flatMap((model) => {
        const value = customModel3D(provider, model);
        return value ? [value] : [];
      });
      models.push(...configured);
      providers.push({ provider: provider.id, providerName: provider.name, state: configured.length ? "ready" : "empty",
        ...(!configured.length ? { message: "Enable 3D models in Models." } : {}) });
    }
    if (this.options.cloud) {
      const catalog = await this.options.cloud.catalog();
      const visible = catalog.models.filter((model) => this.options.isEnabled(model.provider) && this.options.isVisible(model));
      models.push(...visible);
      providers.push(...catalog.providers.filter((provider) => this.options.isEnabled(provider.provider)).map((provider) =>
        provider.state === "ready" && !visible.some((model) => model.provider === provider.provider)
          ? { ...provider, state: "empty" as const, message: "Enable 3D models in Models." } : provider));
    }
    const defaultModel = this.options.defaultModel();
    const resolvedDefault = defaultModel && resolveModel3D(defaultModel, models);
    const index = resolvedDefault ? models.indexOf(resolvedDefault) : -1;
    if (index > 0) models.unshift(...models.splice(index, 1));
    return { models, providers, ...(defaultModel ? { defaultModel } : {}) };
  }

  async resolveModel(ref?: Model3DModelRef): Promise<Model3DModel | undefined> {
    const catalog = await this.catalog();
    const selected = ref ?? catalog.defaultModel;
    return resolveModel3D(selected, catalog.models);
  }

  async generate(input: Model3DGenerationInput, signal?: AbortSignal) {
    if (!this.options.isEnabled(input.model.provider)) throw new Model3DGenerationError("The selected 3D provider is disabled", 409);
    if ((input.operation === undefined || input.operation === "image" || input.operation === "text") && !this.options.isVisible(input.model)) throw new Model3DGenerationError("The selected 3D model is hidden", 409);
    if (input.model.provider.startsWith("cloud-") && this.options.cloud) {
      if (input.operation && input.operation !== "image") throw new Model3DGenerationError("Cloud currently supports image-to-3D only", 400);
      return this.options.cloud.generate(input, signal);
    }
    const selected = await this.resolveOperationModel(input.model, input.operation ?? "image");
    if (!selected) throw new Model3DGenerationError("The selected connection does not support this 3D operation", 400);
    const { generator, settings } = await this.connection(selected, signal);
    return generator.generate(input, signal, settings);
  }

  private nativeModels(provider: Native3DProviderId): Model3DModel[] {
    return this.options.nativeModels(provider).filter((model) => this.options.isVisible({ provider, id: model.id }))
      .map((model) => model3DModel(provider, provider === "hyper3d" ? "Hyper3D · API key" : NATIVE_3D_PROVIDER_NAMES[provider], model));
  }

  /** Operations use configured connections even when their generation models are hidden. */
  async operationModels(): Promise<Model3DModel[]> {
    const models: Model3DModel[] = [];
    for (const provider of Object.keys(NATIVE_3D_PROVIDER_NAMES) as Native3DProviderId[]) {
      if (!this.options[provider]?.configured() || !this.options.isEnabled(provider)) continue;
      const model = model3DModel(provider, NATIVE_3D_PROVIDER_NAMES[provider], {
        ...MODEL_3D_PRESETS[provider][0]!, id: MODEL3D_CONNECTION_ID, name: NATIVE_3D_PROVIDER_NAMES[provider],
      });
      models.push({ ...model, operations: model.operations!.filter((operation) => operation !== "image" && operation !== "text") });
    }
    for (const provider of await this.options.customProviders()) {
      if (!this.options.isEnabled(provider.id) || !(await this.options.runtime()).hasConfiguredAuth(provider.id)) continue;
      models.push(...provider.models.flatMap((definition) => { const model = customModel3D(provider, definition); return model ? [model] : []; }));
    }
    return models;
  }
  async resolveOperationModel(ref: Model3DModelRef | undefined, operation: Model3DOperation): Promise<Model3DModel | undefined> {
    const models = operation === "image" || operation === "text" ? (await this.catalog()).models : await this.operationModels();
    const model = ref ? (operation === "image" || operation === "text" ? resolveModel3D(ref, models) : resolveModel3DConnection(ref, models))
      : operation === "animate" ? models.find((model) => model.provider === "meshy") : models[0];
    return model && (model.operations ?? ["image"]).includes(operation) ? model : undefined;
  }
  private async operationConnection(ref: Model3DModelRef | undefined, operation: Model3DOperation, signal?: AbortSignal) {
    const selected = await this.resolveOperationModel(ref, operation);
    if (!selected) throw new Model3DGenerationError("The selected 3D operation provider is unavailable", 503);
    return (await this.connection(selected, signal)).generator;
  }
  private async connection(model: Model3DModel, signal?: AbortSignal): Promise<{ generator: Connection; settings: CustomModel3DSettings }> {
    if (isNative3DProvider(model.provider)) {
      const connection = this.options[model.provider];
      const settings = model.id === MODEL3D_CONNECTION_ID ? MODEL_3D_PRESETS[model.provider][0]!.settings
        : this.options.nativeModels(model.provider).find((definition) => definition.id === model.id)?.settings;
      if (!connection?.configured() || !settings) throw new Model3DGenerationError("The selected 3D connection is unavailable", 503);
      return { generator: connection.generator, settings };
    }
    const provider = (await this.options.customProviders()).find((provider) => provider.id === model.provider);
    const settings = provider?.models.find((definition) => definition.id === model.id)?.usages?.["3d"];
    if (!provider || !settings) throw new Model3DGenerationError("The selected 3D connection is unavailable", 503);
    const source = await customMediaSource(await this.options.runtime(), provider, settings.baseUrl, signal);
    const key = JSON.stringify([provider.id, model.id]), fingerprint = JSON.stringify([source, settings]);
    let cached = this.#customConnections.get(key);
    if (!cached || cached.fingerprint !== fingerprint) {
      const Provider = PROVIDERS[settings.protocol];
      cached = { fingerprint, generator: new Provider(() => source.apiKey, this.options.request ?? fetch, undefined,
        () => this.options.isEnabled(provider.id), { ...source, settings }) };
      this.#customConnections.set(key, cached);
    }
    return { generator: cached.generator, settings };
  }
  async animate(input: Model3DAnimationInput, signal?: AbortSignal) {
    const connection = await this.operationConnection(input.providerModel, "animate", signal);
    if (!("animate" in connection)) throw new Model3DGenerationError("This provider has no animation API", 400);
    return connection.animate(input, signal);
  }
  async animations(signal?: AbortSignal, model?: Model3DModelRef, options?: Model3DOptions) {
    const connection = await this.operationConnection(model, "animate", signal);
    if (!("animations" in connection)) throw new Model3DGenerationError("This provider has no animation library", 400);
    return connection.animations(signal, model, options);
  }
  async balance(model: Model3DModelRef, signal?: AbortSignal) {
    const selected = resolveModel3DConnection(model, await this.operationModels());
    if (!selected) throw new Model3DGenerationError("The selected 3D connection is unavailable", 503);
    return (await this.connection(selected, signal)).generator.accountBalance(signal);
  }
}
