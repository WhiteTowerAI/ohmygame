import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageModel, ImageModelRef } from "../shared/contracts.js";
import { IMAGE_MODEL_IDS, imageModelDefinition, imageModelsForProvider } from "./image-models.js";
import { createImageProtocolAdapters, type ImageSource } from "./image-adapters.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import { listOpenRouterImageModels, resolveOpenRouterMediaSource } from "./openrouter-media.js";

export class ProviderImages implements ImageGenerator {
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async models(signal?: AbortSignal): Promise<ImageModel[]> {
    const runtime = await this.runtime();
    const [openRouterModels, openAIModels] = await Promise.all([
      this.#openRouterModels(runtime, signal).catch(() => []),
      this.#openAIModels(runtime, signal).catch(() => []),
    ]);
    return [...openRouterModels, ...openAIModels];
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const selection = await this.#selection(input.imageModel, signal);
    const definition = selection?.model;
    if (!selection || !definition) throw new ImageGenerationError("Image generation is not configured", 503);
    if (input.size && !definition.sizes.includes(input.size)) throw new ImageGenerationError("Image size is not supported by the selected model", 400);
    if (input.resolution || input.aspectRatio) {
      const supported = definition.generationOptions.some((option) => option.resolution === input.resolution && option.aspectRatio === input.aspectRatio);
      if (!supported) throw new ImageGenerationError("Image resolution and aspect ratio are not supported by the selected model", 400);
    }
    if (input.images?.length && !definition.supportsReferenceImage) throw new ImageGenerationError("Reference images are not supported by the selected model", 400);
    const adapter = createImageProtocolAdapters(this.request)[definition.protocol];
    const { imageModel: _, ...generationInput } = input;
    return adapter.generate(selection.source, selection.model.id, {
      ...generationInput,
      ...(definition.supportsResolution === false ? { resolution: undefined } : {}),
      ...(definition.supportsAspectRatio === false ? { aspectRatio: undefined } : {}),
    }, signal);
  }

  async #selection(requested?: ImageModelRef, signal?: AbortSignal): Promise<{ model: ImageModel; source: ImageSource } | undefined> {
    const runtime = await this.runtime();
    if (requested?.provider === "openrouter") {
      const source = await resolveOpenRouterMediaSource(runtime, signal);
      if (!source) return undefined;
      const model = (await listOpenRouterImageModels(source, this.request, signal)).find((candidate) => candidate.id === requested.id);
      return model ? { model, source } : undefined;
    }
    if (requested?.provider === "openai") return this.#openAISelection(runtime, requested.id, signal);
    if (requested) return undefined;

    const openRouterSource = await resolveOpenRouterMediaSource(runtime, signal);
    if (openRouterSource) {
      const model = (await listOpenRouterImageModels(openRouterSource, this.request, signal))[0];
      if (model) return { model, source: openRouterSource };
    }
    const openAI = await this.#openAISelection(runtime, undefined, signal);
    if (openAI) return openAI;
    return undefined;
  }

  async #openRouterModels(runtime: ModelRuntime, signal?: AbortSignal): Promise<ImageModel[]> {
    const source = await resolveOpenRouterMediaSource(runtime, signal);
    return source ? listOpenRouterImageModels(source, this.request, signal) : [];
  }

  async #openAIModels(runtime: ModelRuntime, signal?: AbortSignal): Promise<ImageModel[]> {
    const provider = runtime.getProvider("openai");
    if (!provider || !runtime.hasConfiguredAuth("openai")) return [];
    const source = await runtimeSource(runtime, "openai", signal);
    return imageModelsForProvider("openai", provider.name, await modelIds(source, this.request, signal));
  }

  async #openAISelection(runtime: ModelRuntime, requestedId?: string, signal?: AbortSignal): Promise<{ model: ImageModel; source: ImageSource } | undefined> {
    const provider = runtime.getProvider("openai");
    if (!provider || !runtime.hasConfiguredAuth("openai")) return undefined;
    const source = await runtimeSource(runtime, "openai", signal);
    const ids = await modelIds(source, this.request, signal);
    const id = requestedId ? (ids.includes(requestedId) ? requestedId : undefined) : preferredModel(ids);
    const definition = id ? imageModelDefinition(id) : undefined;
    return definition ? { model: { ...definition, provider: "openai", providerName: provider.name }, source } : undefined;
  }
}

function preferredModel(ids: readonly string[]): string | undefined {
  return IMAGE_MODEL_IDS.find((id) => ids.includes(id));
}

async function runtimeSource(runtime: ModelRuntime, provider: string, signal?: AbortSignal): Promise<ImageSource> {
  const definition = runtime.getProvider(provider);
  const resolution = await runtime.getAuth(provider, { signal });
  const apiKey = resolution?.auth?.apiKey;
  if (!definition?.baseUrl || !apiKey) throw new ImageGenerationError("Image generation is not configured", 503);
  return {
    baseUrl: resolution.auth.baseUrl ?? definition.baseUrl,
    apiKey,
    headers: Object.fromEntries(Object.entries(resolution.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

async function modelIds(source: ImageSource, request: typeof fetch, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await request(`${source.baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${source.apiKey}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Model request failed (${response.status})`);
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).flatMap((model) => typeof model.id === "string" ? [model.id] : []);
}
