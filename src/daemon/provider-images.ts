import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageModel, ImageModelRef, MediaModelCatalog, MediaProviderStatus } from "../shared/contracts.js";
import { imageModelDefinition, imageModelsForProvider, preferredImageModelId } from "./image-models.js";
import { createImageProtocolAdapters, type ImageSource } from "./image-adapters.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import { listOpenRouterImageModels, listPublicOpenRouterImageModels, resolveOpenRouterMediaSource } from "./openrouter-media.js";
import { SEEDREAM_BASE_URL, SEEDREAM_PROVIDER_ID, SEEDREAM_PROVIDER_NAME, seedreamModel, seedreamModels } from "./seedream-models.js";

const CAPABILITY_TTL_MS = 10 * 60_000;

export class ProviderImages implements ImageGenerator {
  #capabilities?: { loadedAt: number; models: Promise<ImageModel[]> };

  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly request: typeof fetch = fetch,
    private readonly seedreamApiKey: () => string | undefined = () => undefined,
    private readonly isEnabled: (provider: string) => boolean = () => true,
  ) {}

  async models(signal?: AbortSignal): Promise<ImageModel[]> {
    return (await this.catalog(signal)).models;
  }

  /** Every connected image provider with its models, or the reason it has none. */
  async catalog(signal?: AbortSignal): Promise<MediaModelCatalog<ImageModel>> {
    const runtime = await this.runtime().catch(() => undefined);
    const entries = await Promise.all([
      runtime ? this.#openRouterEntry(runtime, signal) : undefined,
      runtime ? this.#openAIEntry(runtime, signal) : undefined,
      this.#seedreamEntry(),
    ]);
    const connected = entries.filter((entry): entry is CatalogEntry => Boolean(entry));
    return { models: connected.flatMap((entry) => entry.models), providers: connected.map((entry) => entry.status) };
  }

  async #openRouterEntry(runtime: ModelRuntime, signal?: AbortSignal): Promise<CatalogEntry | undefined> {
    if (!this.isEnabled("openrouter")) return undefined;
    const source = await resolveOpenRouterMediaSource(runtime, signal).catch(() => undefined);
    if (!source) return undefined;
    return catalogEntry("openrouter", "OpenRouter", () => listOpenRouterImageModels(source, this.request, signal), "OpenRouter lists no image models for this account.");
  }

  async #openAIEntry(runtime: ModelRuntime, signal?: AbortSignal): Promise<CatalogEntry | undefined> {
    if (!this.isEnabled("openai")) return undefined;
    const provider = runtime.getProvider("openai");
    if (!provider || !runtime.hasConfiguredAuth("openai")) return undefined;
    const signedIn = await Promise.resolve()
      .then(async () => (await runtime.listCredentials()).some((credential) => credential.providerId === "openai" && credential.type === "oauth"))
      .catch(() => false);
    // OpenAI rejects image requests made with a ChatGPT sign-in ("ChatPass credential is not
    // authorized"), and its model list is empty, so don't ask; say what to do instead.
    if (signedIn) {
      return {
        models: [],
        status: { provider: "openai", providerName: provider.name, state: "empty", message: "Sign in with ChatGPT can't generate images. To use GPT Image, connect OpenAI with an API key instead, or connect OpenRouter." },
      };
    }
    return catalogEntry("openai", provider.name, () => this.#openAIModels(runtime, signal), "This OpenAI key or endpoint lists no GPT Image models.");
  }

  #seedreamEntry(): CatalogEntry | undefined {
    if (!this.isEnabled(SEEDREAM_PROVIDER_ID) || !this.seedreamApiKey()) return undefined;
    return {
      models: seedreamModels(),
      status: { provider: SEEDREAM_PROVIDER_ID, providerName: SEEDREAM_PROVIDER_NAME, state: "ready" },
    };
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    if (input.imageModel && !this.isEnabled(input.imageModel.provider)) throw new ImageGenerationError("The selected provider is disabled", 409);
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
    if (requested?.provider === SEEDREAM_PROVIDER_ID) return this.#seedreamSelection(requested.id);
    let runtime: ModelRuntime;
    try {
      runtime = await this.runtime();
    } catch (cause) {
      if (!requested) return this.#seedreamSelection();
      throw cause;
    }
    if (requested?.provider === "openrouter") {
      const source = await resolveOpenRouterMediaSource(runtime, signal);
      if (!source) return undefined;
      const model = (await listOpenRouterImageModels(source, this.request, signal)).find((candidate) => candidate.id === requested.id);
      return model ? { model, source } : undefined;
    }
    if (requested?.provider === "openai") return this.#openAISelection(runtime, requested.id, signal);
    if (requested) return undefined;

    const openRouterSource = this.isEnabled("openrouter") ? await resolveOpenRouterMediaSource(runtime, signal) : undefined;
    if (openRouterSource) {
      const model = (await listOpenRouterImageModels(openRouterSource, this.request, signal))[0];
      if (model) return { model, source: openRouterSource };
    }
    const openAI = await this.#openAISelection(runtime, undefined, signal);
    if (openAI) return openAI;
    return this.#seedreamSelection();
  }

  #seedreamSelection(requestedId?: string): { model: ImageModel; source: ImageSource } | undefined {
    if (!this.isEnabled(SEEDREAM_PROVIDER_ID)) return undefined;
    const apiKey = this.seedreamApiKey();
    const model = requestedId ? seedreamModel(requestedId) : seedreamModels()[0];
    return apiKey && model ? { model, source: { baseUrl: SEEDREAM_BASE_URL, apiKey } } : undefined;
  }

  async #openRouterModels(runtime: ModelRuntime, signal?: AbortSignal): Promise<ImageModel[]> {
    const source = await resolveOpenRouterMediaSource(runtime, signal);
    return source ? listOpenRouterImageModels(source, this.request, signal) : [];
  }

  async #openAIModels(runtime: ModelRuntime, signal?: AbortSignal): Promise<ImageModel[]> {
    const provider = runtime.getProvider("openai");
    if (!provider || !runtime.hasConfiguredAuth("openai")) return [];
    const source = await runtimeSource(runtime, "openai", signal);
    const [ids, catalog] = await Promise.all([modelIds(source, this.request, signal), this.#capabilityCatalog(signal)]);
    return imageModelsForProvider("openai", provider.name, ids, catalog);
  }

  /** Capabilities for models reached directly; a failed lookup falls back to each family's defaults. */
  #capabilityCatalog(signal?: AbortSignal): Promise<ImageModel[]> {
    if (!this.#capabilities || Date.now() - this.#capabilities.loadedAt > CAPABILITY_TTL_MS) {
      const models = listPublicOpenRouterImageModels(this.request, signal).catch(() => {
        this.#capabilities = undefined;
        return [];
      });
      this.#capabilities = { loadedAt: Date.now(), models };
    }
    return this.#capabilities.models;
  }

  async #openAISelection(runtime: ModelRuntime, requestedId?: string, signal?: AbortSignal): Promise<{ model: ImageModel; source: ImageSource } | undefined> {
    if (!this.isEnabled("openai")) return undefined;
    const provider = runtime.getProvider("openai");
    if (!provider || !runtime.hasConfiguredAuth("openai")) return undefined;
    const source = await runtimeSource(runtime, "openai", signal);
    const [ids, catalog] = await Promise.all([modelIds(source, this.request, signal), this.#capabilityCatalog(signal)]);
    const id = requestedId ? (ids.includes(requestedId) ? requestedId : undefined) : preferredImageModelId(ids);
    const definition = id ? imageModelDefinition(id, catalog) : undefined;
    return definition ? { model: { ...definition, provider: "openai", providerName: provider.name }, source } : undefined;
  }
}

interface CatalogEntry {
  models: ImageModel[];
  status: MediaProviderStatus;
}

async function catalogEntry(provider: string, providerName: string, list: () => Promise<ImageModel[]>, emptyMessage: string): Promise<CatalogEntry> {
  try {
    const models = await list();
    return {
      models,
      status: models.length ? { provider, providerName, state: "ready" } : { provider, providerName, state: "empty", message: emptyMessage },
    };
  } catch (cause) {
    return { models: [], status: { provider, providerName, state: "error", message: cause instanceof Error ? cause.message : String(cause) } };
  }
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
