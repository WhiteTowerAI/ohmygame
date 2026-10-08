import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CUSTOM_IMAGE_MODEL_APIS, type CustomProviderSettings, type ImageModel, type ImageModelCatalog, type ImageModelRef, type MediaProviderStatus } from "../shared/contracts.js";
import { imageModelsForProvider } from "./image-models.js";
import { createImageProtocolAdapters, type ImageSource } from "./image-adapters.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import { listOpenRouterImageModels, listPublicOpenRouterImageModels, resolveOpenRouterMediaSource } from "./openrouter-media.js";
import { SEEDREAM_BASE_URL, SEEDREAM_PROVIDER_ID, SEEDREAM_PROVIDER_NAME, seedreamModel, seedreamModels } from "./seedream-models.js";

const CAPABILITY_TTL_MS = 10 * 60_000;

interface ProviderImagesOptions {
  customProviders?: () => Promise<CustomProviderSettings[]>;
  defaultModel?: () => ImageModelRef | undefined;
}

interface ImageSelection {
  model: ImageModel;
  source: ImageSource;
}

export class ProviderImages implements ImageGenerator {
  #capabilities?: { loadedAt: number; models: Promise<ImageModel[]> };

  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly request: typeof fetch = fetch,
    private readonly seedreamApiKey: () => string | undefined = () => undefined,
    private readonly isEnabled: (provider: string) => boolean = () => true,
    private readonly options: ProviderImagesOptions = {},
  ) {}

  async models(signal?: AbortSignal): Promise<ImageModel[]> {
    return (await this.catalog(signal)).models;
  }

  /** Every connected image provider with its models, or the reason it has none. */
  async catalog(signal?: AbortSignal): Promise<ImageModelCatalog> {
    const runtime = await this.runtime().catch(() => undefined);
    const custom = runtime ? await this.#customImageProviders(runtime) : [];
    const entries = await Promise.all([
      runtime ? this.#openRouterEntry(runtime, signal) : undefined,
      runtime ? this.#openAIEntry(runtime, signal) : undefined,
      this.#seedreamEntry(),
      ...custom.map((provider) => catalogEntry(provider.id, provider.name, () => this.#compatibleModels(runtime!, provider.id, signal), "This endpoint lists no supported image models.")),
    ]);
    const connected = entries.filter((entry): entry is CatalogEntry => Boolean(entry));
    const models = connected.flatMap((entry) => entry.models);
    const defaultModel = this.options.defaultModel?.();
    const defaultIndex = models.findIndex((model) => model.provider === defaultModel?.provider && model.id === defaultModel.id);
    if (defaultIndex > 0) models.unshift(...models.splice(defaultIndex, 1));
    return { models, providers: connected.map((entry) => entry.status), ...(defaultModel ? { defaultModel } : {}) };
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
    // OpenAI rejects image requests made with a ChatGPT sign-in ("ChatPass credential is not
    // authorized"), and its model list is empty, so don't ask; say what to do instead.
    if (runtime.isUsingOAuth("openai")) {
      return {
        models: [],
        status: { provider: "openai", providerName: provider.name, state: "empty", message: "Browser sign-in does not include image generation. Connect OpenAI with an API key, or choose another image provider." },
      };
    }
    return catalogEntry("openai", provider.name, () => this.#compatibleModels(runtime, "openai", signal), "This OpenAI key or endpoint lists no GPT Image models.");
  }

  async #customImageProviders(runtime: ModelRuntime): Promise<CustomProviderSettings[]> {
    return (await this.options.customProviders?.() ?? []).filter((provider) => CUSTOM_IMAGE_MODEL_APIS.some((api) => api === provider.api)
      && this.isEnabled(provider.id) && runtime.hasConfiguredAuth(provider.id));
  }

  #seedreamEntry(): CatalogEntry | undefined {
    if (!this.isEnabled(SEEDREAM_PROVIDER_ID) || !this.seedreamApiKey()) return undefined;
    return {
      models: seedreamModels(),
      status: { provider: SEEDREAM_PROVIDER_ID, providerName: SEEDREAM_PROVIDER_NAME, state: "ready" },
    };
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const requested = input.imageModel ?? this.options.defaultModel?.();
    if (requested && !this.isEnabled(requested.provider)) throw new ImageGenerationError("The selected image provider is disabled. Enable it or choose another default image model.", 409);
    const selection = await this.#selection(requested, signal);
    const definition = selection?.model;
    if (!selection || !definition) throw new ImageGenerationError(requested
      ? "The selected image model is unavailable. Choose a connected image provider or update the default image model in Providers."
      : "Image generation is not configured", 503);
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

  async #selection(requested?: ImageModelRef, signal?: AbortSignal): Promise<ImageSelection | undefined> {
    if (requested?.provider === SEEDREAM_PROVIDER_ID) return this.#seedreamSelection(requested.id);
    let runtime: ModelRuntime;
    try {
      runtime = await this.runtime();
    } catch (cause) {
      signal?.throwIfAborted();
      if (!requested) return this.#seedreamSelection();
      throw cause;
    }
    if (requested?.provider === "openrouter") return this.#openRouterSelection(runtime, requested.id, signal);
    if (requested?.provider === "openai") return this.#compatibleSelection(runtime, "openai", requested.id, signal);
    const custom = await this.#customImageProviders(runtime);
    if (requested && custom.some((provider) => provider.id === requested.provider)) return this.#compatibleSelection(runtime, requested.provider, requested.id, signal);
    if (requested) return undefined;

    // Automatic selection can skip a failed catalog. An explicit selection above always
    // keeps its provider, and a failed generation is never retried through another one.
    const candidates = [
      () => this.#openRouterSelection(runtime, undefined, signal),
      () => this.#compatibleSelection(runtime, "openai", undefined, signal),
      () => this.#seedreamSelection(),
      ...custom.map((provider) => () => this.#compatibleSelection(runtime, provider.id, undefined, signal)),
    ];
    for (const select of candidates) {
      signal?.throwIfAborted();
      try {
        const selection = await select();
        if (selection) return selection;
      } catch {
        signal?.throwIfAborted();
      }
    }
    return undefined;
  }

  async #openRouterSelection(runtime: ModelRuntime, requestedId?: string, signal?: AbortSignal): Promise<ImageSelection | undefined> {
    if (!this.isEnabled("openrouter")) return undefined;
    const source = await resolveOpenRouterMediaSource(runtime, signal);
    if (!source) return undefined;
    const models = await listOpenRouterImageModels(source, this.request, signal);
    const model = requestedId ? models.find((candidate) => candidate.id === requestedId) : models[0];
    return model ? { model, source } : undefined;
  }

  #seedreamSelection(requestedId?: string): ImageSelection | undefined {
    if (!this.isEnabled(SEEDREAM_PROVIDER_ID)) return undefined;
    const apiKey = this.seedreamApiKey();
    const model = requestedId ? seedreamModel(requestedId) : seedreamModels()[0];
    return apiKey && model ? { model, source: { baseUrl: SEEDREAM_BASE_URL, apiKey } } : undefined;
  }

  async #compatibleModels(runtime: ModelRuntime, providerId: string, signal?: AbortSignal, source?: ImageSource): Promise<ImageModel[]> {
    const provider = runtime.getProvider(providerId);
    if (!provider || !runtime.hasConfiguredAuth(providerId)) return [];
    source ??= await runtimeSource(runtime, providerId, signal);
    const [ids, catalog] = await Promise.all([modelIds(source, this.request, signal), this.#capabilityCatalog(signal)]);
    return imageModelsForProvider(providerId, provider.name, ids, catalog);
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

  async #compatibleSelection(runtime: ModelRuntime, providerId: string, requestedId?: string, signal?: AbortSignal): Promise<ImageSelection | undefined> {
    if (!this.isEnabled(providerId) || !runtime.hasConfiguredAuth(providerId) || runtime.isUsingOAuth(providerId)) return undefined;
    const source = await runtimeSource(runtime, providerId, signal);
    const models = await this.#compatibleModels(runtime, providerId, signal, source);
    const model = requestedId ? models.find((candidate) => candidate.id === requestedId) : models[0];
    return model ? { model, source } : undefined;
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
    headers: { ...source.headers, authorization: `Bearer ${source.apiKey}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Model request failed (${response.status})`);
  const body = await response.json() as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).flatMap((model) => typeof model.id === "string" ? [model.id] : []);
}
