import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomProviderDetails, MediaModelCatalog, Model3DModel, Model3DModelRef } from "../shared/contracts.js";
import { customModel3D } from "../shared/custom-models.js";
import { MODEL_3D_MODELS } from "../shared/generation-config.js";
import { customMediaSource } from "./custom-media-source.js";
import { TripoProvider } from "./tripo-provider.js";
import { MeshyProvider } from "./meshy-provider.js";
import { Model3DGenerationError, type Model3DGenerator, type Model3DGenerationInput, type Model3DAnimationInput } from "./model3d.js";

export class ProviderModels3D implements Model3DGenerator {
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly meshy: MeshyProvider,
    private readonly meshyConfigured: () => boolean,
    private readonly providers: () => Promise<CustomProviderDetails[]>,
    private readonly isEnabled: (provider: string) => boolean,
    private readonly request: typeof fetch = fetch,
    private readonly defaultModel: () => Model3DModelRef | undefined = () => undefined,
    private readonly tripo?: { generator: TripoProvider; configured: () => boolean },
  ) {}

  async catalog(): Promise<MediaModelCatalog<Model3DModel>> {
    const models: Model3DModel[] = [];
    const providers: MediaModelCatalog<Model3DModel>["providers"] = [];
    if (this.meshyConfigured() && this.isEnabled("meshy")) {
      models.push(...MODEL_3D_MODELS.filter((model) => model.provider === "meshy"));
      providers.push({ provider: "meshy", providerName: "Meshy", state: "ready" });
    }
    if (this.tripo?.configured() && this.isEnabled("tripo")) {
      models.push(...MODEL_3D_MODELS.filter((model) => model.provider === "tripo"));
      providers.push({ provider: "tripo", providerName: "Tripo", state: "ready" });
    }
    for (const provider of await this.providers()) {
      if (!this.isEnabled(provider.id) || !provider.models.some((model) => model.usages?.["3d"]) || !(await this.runtime()).hasConfiguredAuth(provider.id)) continue;
      const configured = provider.models.filter((model) => !provider.hiddenModelIds.includes(model.id)).flatMap((model) => {
        const value = customModel3D(provider, model);
        return value ? [value] : [];
      });
      models.push(...configured);
      providers.push({ provider: provider.id, providerName: provider.name, state: configured.length ? "ready" : "empty",
        ...(!configured.length ? { message: "Enable 3D models in Models." } : {}) });
    }
    const defaultModel = this.defaultModel();
    const index = models.findIndex((model) => model.provider === defaultModel?.provider && model.id === defaultModel.id);
    if (index > 0) models.unshift(...models.splice(index, 1));
    return { models, providers, ...(defaultModel ? { defaultModel } : {}) };
  }

  async resolveModel(ref?: Model3DModelRef): Promise<Model3DModel | undefined> {
    const catalog = await this.catalog();
    const selected = ref ?? catalog.defaultModel;
    return selected ? catalog.models.find((model) => model.provider === selected.provider && model.id === selected.id) : catalog.models[0];
  }

  async generate(input: Model3DGenerationInput, signal?: AbortSignal) {
    if (!this.isEnabled(input.model.provider)) throw new Model3DGenerationError("The selected 3D provider is disabled", 409);
    if (input.model.provider === "meshy") return this.meshy.generate(input, signal);
    if (input.model.provider === "tripo" && this.tripo) return this.tripo.generator.generate(input, signal);
    const provider = (await this.providers()).find((provider) => provider.id === input.model.provider);
    const definition = provider?.models.find((model) => model.id === input.model.id && !provider.hiddenModelIds.includes(model.id));
    const config = definition?.usages?.["3d"];
    if (!provider || !config) throw new Model3DGenerationError("The selected 3D model is unavailable", 503);
    if (input.texture && !config.supportsTexture || input.pbr && !config.supportsPbr) throw new Model3DGenerationError("The selected 3D model does not support these texture options", 400);
    const source = await customMediaSource(await this.runtime(), provider, config.baseUrl, signal);
    const Provider = config.protocol === "tripo" ? TripoProvider : MeshyProvider;
    return new Provider(() => source.apiKey, this.request, undefined, () => this.isEnabled(provider.id),
      { ...source, settings: config }).generate({ ...input, texture: input.texture ?? config.supportsTexture, pbr: input.pbr ?? false }, signal);
  }

  // Animation remains an explicitly Meshy capability, independent of custom 3D generation.
  animate(input: Model3DAnimationInput, signal?: AbortSignal) { return this.meshy.animate(input, signal); }
  animations(signal?: AbortSignal) { return this.meshy.animations(signal); }
}
