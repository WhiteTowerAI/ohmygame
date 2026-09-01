import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageModel, ImageModelRef } from "../shared/contracts.js";
import { imageModelDefinition, imageModelsForProvider } from "./image-models.js";
import { createImageProtocolAdapters, type ImageSource } from "./image-adapters.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import type { PortalConnection } from "./portal-connection.js";

export class ProviderImages implements ImageGenerator {
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly portal: PortalConnection,
    private readonly selected: () => ImageModelRef | undefined,
    private readonly request: typeof fetch = fetch,
  ) {}

  async models(signal?: AbortSignal): Promise<ImageModel[]> {
    const portal = this.portal.imageSource();
    const portalModels = portal
      ? imageModelsForProvider("opengame", "OpenGame Portal", portal.modelIds)
      : [];
    const runtime = await this.runtime();
    const openAI = runtime.getProvider("openai");
    if (!openAI || !runtime.hasConfiguredAuth("openai")) return portalModels;
    try {
      const source = await runtimeSource(runtime, "openai");
      const ids = await modelIds(source, this.request, signal);
      return [...portalModels, ...imageModelsForProvider("openai", openAI.name, ids)];
    } catch {
      return portalModels;
    }
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const selected = this.selected();
    const definition = selected ? imageModelDefinition(selected.id) : undefined;
    if (!selected || !definition) throw new ImageGenerationError("Image generation is not configured", 503);
    if (input.size && !definition.sizes.includes(input.size)) throw new ImageGenerationError("Image size is not supported by the selected model", 400);
    if (input.resolution || input.aspectRatio) {
      const supported = definition.generationOptions.some((option) => option.resolution === input.resolution && option.aspectRatio === input.aspectRatio);
      if (!supported) throw new ImageGenerationError("Image resolution and aspect ratio are not supported by the selected model", 400);
    }
    if (input.image && !definition.supportsReferenceImage) throw new ImageGenerationError("Reference images are not supported by the selected model", 400);
    let source: ImageSource | undefined;
    if (selected.provider === "opengame") {
      const portal = this.portal.imageSource();
      if (portal && portal.modelIds.includes(selected.id)) source = portal;
    } else {
      const runtime = await this.runtime();
      source = await runtimeSource(runtime, selected.provider);
      const ids = await modelIds(source, this.request, signal);
      if (!ids.includes(selected.id)) source = undefined;
    }
    if (!source) throw new ImageGenerationError("Image generation is not configured", 503);
    const adapter = createImageProtocolAdapters(this.request)[definition.protocol];
    return adapter.generate(source, selected.id, input, signal);
  }
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
