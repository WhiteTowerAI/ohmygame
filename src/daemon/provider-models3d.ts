import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomProviderDetails, MediaModelCatalog, Model3DDefinition, Model3DModel, Model3DModelRef } from "../shared/contracts.js";
import { customModel3D, model3DModel } from "../shared/custom-models.js";
import { resolveModel3D } from "../shared/generation-config.js";
import { isNative3DProvider, NATIVE_3D_PROVIDER_NAMES, type Native3DProviderId } from "../shared/model3d-presets.js";
import { customMediaSource } from "./custom-media-source.js";
import { TripoProvider } from "./tripo-provider.js";
import { MeshyProvider } from "./meshy-provider.js";
import { Hyper3DProvider } from "./hyper3d-provider.js";
import { Model3DGenerationError, type Model3DGenerator, type Model3DGenerationInput, type Model3DAnimationInput } from "./model3d.js";
import type { CloudModelsClient } from "./cloud-models.js";

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
    if (!this.options.isVisible(input.model)) throw new Model3DGenerationError("The selected 3D model is hidden", 409);
    if (input.model.provider.startsWith("cloud-") && this.options.cloud) return this.options.cloud.generate(input, signal);
    if (isNative3DProvider(input.model.provider)) {
      const settings = this.options.nativeModels(input.model.provider).find((model) => model.id === input.model.id)?.settings;
      if (!settings) throw new Model3DGenerationError("The selected 3D model is unavailable", 503);
      const connection = this.options[input.model.provider];
      if (!connection) throw new Model3DGenerationError("The selected 3D provider is unavailable", 503);
      return connection.generator.generate(input, signal, settings);
    }
    const provider = (await this.options.customProviders()).find((provider) => provider.id === input.model.provider);
    const definition = provider?.models.find((model) => model.id === input.model.id && !provider.hiddenModelIds.includes(model.id));
    const config = definition?.usages?.["3d"];
    if (!provider || !config) throw new Model3DGenerationError("The selected 3D model is unavailable", 503);
    const source = await customMediaSource(await this.options.runtime(), provider, config.baseUrl, signal);
    const Provider = { tripo: TripoProvider, meshy: MeshyProvider, hyper3d: Hyper3DProvider }[config.protocol];
    return new Provider(() => source.apiKey, this.options.request ?? fetch, undefined, () => this.options.isEnabled(provider.id),
      { ...source, settings: config }).generate(input, signal);
  }

  private nativeModels(provider: Native3DProviderId): Model3DModel[] {
    return this.options.nativeModels(provider).filter((model) => this.options.isVisible({ provider, id: model.id }))
      .map((model) => model3DModel(provider, provider === "hyper3d" ? "Hyper3D · API key" : NATIVE_3D_PROVIDER_NAMES[provider], model));
  }

  // Animation remains an explicitly Meshy capability, independent of custom 3D generation.
  animate(input: Model3DAnimationInput, signal?: AbortSignal) { return this.options.meshy.generator.animate(input, signal); }
  animations(signal?: AbortSignal) { return this.options.meshy.generator.animations(signal); }
}
