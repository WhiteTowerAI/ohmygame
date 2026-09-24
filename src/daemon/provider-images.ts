import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageModel, ImageModelRef } from "../shared/contracts.js";
import { IMAGE_MODEL_IDS, imageModelDefinition, imageModelsForProvider } from "./image-models.js";
import { createImageProtocolAdapters, type ImageSource } from "./image-adapters.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import type { AccountConnection } from "./account-connection.js";

export class ProviderImages implements ImageGenerator {
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly accountConnection: AccountConnection,
    private readonly request: typeof fetch = fetch,
  ) {}

  async models(signal?: AbortSignal): Promise<ImageModel[]> {
    const accountSource = this.accountConnection.imageSource();
    const accountModels = accountSource
      ? imageModelsForProvider("ohmygame", "OhMyGame account", accountSource.modelIds)
      : [];
    const runtime = await this.runtime();
    const openAI = runtime.getProvider("openai");
    if (!openAI || !runtime.hasConfiguredAuth("openai")) return accountModels;
    try {
      const source = await runtimeSource(runtime, "openai");
      const ids = await modelIds(source, this.request, signal);
      return [...accountModels, ...imageModelsForProvider("openai", openAI.name, ids)];
    } catch {
      return accountModels;
    }
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const selection = await this.#selection(input.imageModel, signal);
    const definition = selection ? imageModelDefinition(selection.model.id) : undefined;
    if (!selection || !definition) throw new ImageGenerationError("Image generation is not configured", 503);
    if (input.size && !definition.sizes.includes(input.size)) throw new ImageGenerationError("Image size is not supported by the selected model", 400);
    if (input.resolution || input.aspectRatio) {
      const supported = definition.generationOptions.some((option) => option.resolution === input.resolution && option.aspectRatio === input.aspectRatio);
      if (!supported) throw new ImageGenerationError("Image resolution and aspect ratio are not supported by the selected model", 400);
    }
    if (input.images?.length && !definition.supportsReferenceImage) throw new ImageGenerationError("Reference images are not supported by the selected model", 400);
    const adapter = createImageProtocolAdapters(this.request)[definition.protocol];
    const { imageModel: _, ...generationInput } = input;
    return adapter.generate(selection.source, selection.model.id, generationInput, signal);
  }

  async #selection(requested?: ImageModelRef, signal?: AbortSignal): Promise<{ model: ImageModelRef; source: ImageSource } | undefined> {
    const accountSource = this.accountConnection.imageSource();
    if (requested?.provider === "ohmygame") {
      return accountSource?.modelIds.includes(requested.id) ? { model: requested, source: accountSource } : undefined;
    }
    if (!requested && accountSource) {
      const id = preferredModel(accountSource.modelIds);
      if (id) return { model: { provider: "ohmygame", id }, source: accountSource };
    }

    const runtime = await this.runtime();
    const provider = requested?.provider ?? "openai";
    if (!runtime.getProvider(provider) || !runtime.hasConfiguredAuth(provider)) return undefined;
    try {
      const source = await runtimeSource(runtime, provider);
      const ids = await modelIds(source, this.request, signal);
      const id = requested ? (ids.includes(requested.id) ? requested.id : undefined) : preferredModel(ids);
      return id ? { model: { provider, id }, source } : undefined;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      return undefined;
    }
  }
}

function preferredModel(ids: readonly string[]): string | undefined {
  return IMAGE_MODEL_IDS.find((id) => ids.includes(id));
}

async function runtimeSource(runtime: ModelRuntime, provider: string): Promise<ImageSource> {
  const definition = runtime.getProvider(provider);
  const resolution = await runtime.getAuth(provider) as { auth?: { apiKey?: string } } | undefined;
  const apiKey = resolution?.auth?.apiKey;
  if (!definition?.baseUrl || !apiKey) throw new ImageGenerationError("Image generation is not configured", 503);
  return { baseUrl: definition.baseUrl, apiKey };
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
