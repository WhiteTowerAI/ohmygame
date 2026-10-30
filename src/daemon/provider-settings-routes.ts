import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { AUDIO_VOICE_ID_MAX_LENGTH, AUDIO_VOICE_ID_PATTERN } from "../shared/audio.js";
import { RESPONSES_TRANSPORT_MODES, type DiscoverProviderModelsRequest, type ModelAuthMethod, type ProviderModelSettings, type ResponsesTransportSettings } from "../shared/contracts.js";
import { modelUsageList, modelUsages } from "../shared/custom-models.js";
import { isNative3DProvider, model3DPreset, normalizeNativeModel3D, MODEL_3D_CATALOG_DOCS, MODEL_3D_CATALOG_REVIEWED } from "../shared/model3d-presets.js";
import { supportedReasoningLevels } from "../shared/reasoning.js";
import type { AgentManager } from "./agent.js";
import { AudioGenerationError } from "./audio-generation.js";
import type { CloudModelsClient } from "./cloud-models.js";
import { customModelCatalog } from "./custom-model-capabilities.js";
import type { MediaProviderKeyStore } from "./media-provider-settings.js";
import { isMinimaxProviderId } from "./minimax-models.js";
import type { MinimaxSettingsStore } from "./minimax-settings.js";
import { ModelAuthError, type ModelAuthManager } from "./model-auth.js";
import { MODEL_CATALOG_REFRESH_ERROR, type ModelCatalogRefresh } from "./model-catalog-refresh.js";
import type { ModelEndpointSettingsStore } from "./model-endpoint-settings.js";
import type { OpenAIImageSettingsStore } from "./openai-image-settings.js";
import type { ProjectManager } from "./projects.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import { normalizeCustomProvider, normalizeCustomProviderModel, type ProviderModelSettingsStore } from "./provider-model-settings.js";
import { isSeedanceProviderId } from "./seedance-models.js";
import type { SeedanceSettingsStore } from "./seedance-settings.js";
import type { DoubaoService, DoubaoVoiceSettingsStore } from "./doubao-voice-settings.js";
import type { VolcengineSeedAudioProvider } from "./volcengine-seed-audio-provider.js";
import type { VolcengineTtsProvider } from "./volcengine-tts-provider.js";

const modelAuthLoginSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["method"],
    properties: { method: { enum: ["api_key", "oauth"] } },
  },
} as const;

const modelAuthResponseSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["promptId", "value"],
    properties: {
      promptId: { type: "string", minLength: 1, maxLength: 100 },
      value: { type: "string", maxLength: 100_000 },
    },
  },
} as const;

const modelEndpointSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", minLength: 1, maxLength: 2_000 } },
  },
} as const;

const apiKeySettingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["apiKey"],
    properties: { apiKey: { type: "string", minLength: 1, maxLength: 10_000 } },
  },
} as const;

/** What the provider and model settings routes use from the daemon. */
export interface ProviderSettingsRouteOptions {
  providerSummaries: () => Promise<readonly { id: string; configured: boolean; managed?: string }[]>;
  providerModelSettings: ProviderModelSettingsStore;
  catalogRefresh: ModelCatalogRefresh;
  getModelRuntime: () => Promise<ModelRuntime>;
  projects: ProjectManager;
  agents: AgentManager;
  modelDiscoveryFetch: typeof fetch | undefined;
  native3DProviders: readonly (readonly [string, string, MediaProviderKeyStore])[];
  openAIEndpoint: ModelEndpointSettingsStore;
  seedanceSettings: SeedanceSettingsStore;
  minimaxSettings: MinimaxSettingsStore;
  doubaoVoiceSettings: DoubaoVoiceSettingsStore;
  syncOpenAIEndpoint: (runtime: ModelRuntime) => Promise<void>;
  openAIImages: OpenAIImageSettingsStore;
  volcengineTtsProvider: VolcengineTtsProvider;
  volcengineSeedAudioProvider: VolcengineSeedAudioProvider;
  providerEnabled: (id: string) => boolean;
  cloudModels: CloudModelsClient;
  modelAuth: ModelAuthManager;
}

/** Settings → Providers & Models: provider connections, keys, custom providers, model lists, and sign-in. */
export function registerProviderSettingsRoutes(app: FastifyInstance, options: ProviderSettingsRouteOptions): void {
  const {
    providerSummaries,
    providerModelSettings,
    catalogRefresh,
    getModelRuntime,
    projects,
    agents,
    modelDiscoveryFetch,
    native3DProviders,
    openAIEndpoint,
    seedanceSettings,
    minimaxSettings,
    doubaoVoiceSettings,
    syncOpenAIEndpoint,
    openAIImages,
    volcengineTtsProvider,
    volcengineSeedAudioProvider,
    providerEnabled,
    cloudModels,
    modelAuth,
  } = options;

  app.patch<{ Params: { providerId: string }; Body: { enabled: boolean } }>("/settings/models/providers/:providerId/enabled", {
    schema: { body: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } } },
  }, async (request, reply) => {
    const provider = (await providerSummaries()).find((item) => item.id === request.params.providerId);
    if (!provider) return reply.code(404).send({ error: "Provider not found" });
    const hyper3d = provider.id === "hyper3d" || provider.id === "cloud-hyper3d";
    if (!provider.configured && provider.id !== "codex-cli" && !hyper3d && !("managed" in provider && provider.managed)) return reply.code(400).send({ error: "Connect the provider before enabling it" });
    await providerModelSettings.setEnabled(hyper3d ? ["hyper3d", "cloud-hyper3d"] : provider.id, request.body.enabled);
    catalogRefresh.invalidate(provider.id);
    return { ...provider, enabled: request.body.enabled };
  });

  const saveCustomProvider = async (value: unknown, id: string) => {
    const runtime = await getModelRuntime();
    const catalog = customModelCatalog(runtime.getModels());
    const settings = normalizeCustomProvider(value, catalog);
    const previous = await providerModelSettings.customProvider(id, catalog);
    if (settings.authentication === "api_key" && !settings.apiKey && (previous?.authentication !== "api_key" || !runtime.hasConfiguredAuth(id))) throw new Error("API key is required");
    try {
      await providerModelSettings.saveCustomProvider(id, settings, async () => {
        await runtime.refresh({ allowNetwork: false, providers: [id] });
        // Compatible local services accept an internal placeholder; users do not need a key.
        const apiKey = settings.authentication === "none" ? "ohmygame-local" : settings.apiKey;
        if (apiKey) await runtime.login(id, "api_key", { signal: new AbortController().signal, notify: () => {}, prompt: async () => apiKey });
      });
    } catch (cause) {
      await runtime.refresh({ allowNetwork: false });
      throw cause;
    }
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
    return providerModelSettings.customProvider(id, customModelCatalog(runtime.getModels()));
  };

  app.post<{ Body: DiscoverProviderModelsRequest }>("/settings/models/providers/discover", async (request, reply) => {
    try {
      const runtime = await getModelRuntime();
      const catalog = customModelCatalog(runtime.getModels());
      let connection = request.body;
      if (connection?.providerId !== undefined) {
        if (typeof connection.providerId !== "string" || !providerModelSettings.isCustom(connection.providerId)) return reply.code(404).send({ error: "Custom provider not found" });
        if (connection.authentication === "api_key" && !connection.apiKey?.trim()) {
          const provider = await providerModelSettings.customProvider(connection.providerId, catalog);
          if (provider?.authentication === "api_key") connection = { ...connection, apiKey: (await runtime.getAuth(connection.providerId))?.auth?.apiKey };
        }
      }
      return await discoverProviderModels(connection, modelDiscoveryFetch, catalog);
    }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.post("/settings/models/providers/custom", async (request, reply) => {
    try { return reply.code(201).send(await saveCustomProvider(request.body, `custom-${randomUUID()}`)); }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.get<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/custom", async (request, reply) => {
    const { providerId } = request.params;
    const settings = await providerModelSettings.customProvider(providerId, customModelCatalog((await getModelRuntime()).getModels()));
    if (!settings) return reply.code(404).send({ error: "Custom provider not found" });
    return settings;
  });
  app.put<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/custom", async (request, reply) => {
    if (!providerModelSettings.isCustom(request.params.providerId)) return reply.code(404).send({ error: "Custom provider not found" });
    try { return await saveCustomProvider(request.body, request.params.providerId); }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  const removeProvider = async (providerId: string) => {
    const runtime = await getModelRuntime();
    const native = native3DProviders.find(([id]) => id === providerId);
    const seedance = isSeedanceProviderId(providerId);
    const minimax = isMinimaxProviderId(providerId);
    const volcengineTts = providerId === "volcengine-tts";
    const volcengineSeedAudio = providerId === "volcengine-seed-audio";
    if (!native && !seedance && !minimax && !volcengineTts && !volcengineSeedAudio && !runtime.getProvider(providerId)) throw new ModelAuthError("Model provider not found", 404);
    catalogRefresh.invalidate(providerId);
    const previousEndpoint = providerId === "openai" ? openAIEndpoint.override() : undefined;
    try {
      await providerModelSettings.removeProviderSettings(providerId, async () => {
        await runtime.refresh({ allowNetwork: false });
        if (previousEndpoint) await openAIEndpoint.update(openAIEndpoint.defaultBaseUrl);
        if (native) await native[2].clear();
        else if (seedance) await seedanceSettings.clear(providerId);
        else if (minimax) await minimaxSettings.clear(providerId);
        else if (volcengineTts || volcengineSeedAudio) await doubaoVoiceSettings.setService(providerId as DoubaoService, null);
        else await runtime.logout(providerId);
        await syncOpenAIEndpoint(runtime);
        if (providerId === "openai") await openAIImages.clear(false);
      });
    } catch (cause) {
      if (previousEndpoint) await openAIEndpoint.update(previousEndpoint);
      await runtime.refresh({ allowNetwork: false });
      await syncOpenAIEndpoint(runtime);
      throw cause;
    }
    for (const project of projects.list()) agents.invalidateProjectSessions(project.id);
  };
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId", async (request, reply) => {
    try {
      await removeProvider(request.params.providerId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/custom", async (request, reply) => {
    if (!providerModelSettings.isCustom(request.params.providerId)) return reply.code(404).send({ error: "Custom provider not found" });
    await removeProvider(request.params.providerId);
    return reply.code(204).send();
  });

  for (const [id, , settings] of native3DProviders) {
    app.get(`/settings/models/providers/${id}`, async () => settings.get());
    app.put<{ Body: { apiKey: string } }>(`/settings/models/providers/${id}`, { schema: apiKeySettingsSchema }, async (request, reply) => {
      try { return await settings.update(request.body.apiKey); }
      catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    });
  }

  app.put<{ Params: { providerId: string }; Body: { apiKey: string } }>(
    "/settings/models/providers/:providerId/seedance-key",
    { schema: apiKeySettingsSchema },
    async (request, reply) => {
      if (!isSeedanceProviderId(request.params.providerId)) return reply.code(404).send({ error: "Seedance provider not found" });
      try { return await seedanceSettings.update(request.params.providerId, request.body.apiKey); }
      catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    },
  );
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/seedance-key", async (request, reply) => {
    if (!isSeedanceProviderId(request.params.providerId)) return reply.code(404).send({ error: "Seedance provider not found" });
    await seedanceSettings.clear(request.params.providerId);
    return reply.code(204).send();
  });

  app.put<{ Params: { providerId: string }; Body: { apiKey: string } }>(
    "/settings/models/providers/:providerId/minimax-key",
    { schema: apiKeySettingsSchema },
    async (request, reply) => {
      if (!isMinimaxProviderId(request.params.providerId)) return reply.code(404).send({ error: "MiniMax provider not found" });
      try { return await minimaxSettings.update(request.params.providerId, request.body.apiKey); }
      catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
    },
  );
  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/minimax-key", async (request, reply) => {
    if (!isMinimaxProviderId(request.params.providerId)) return reply.code(404).send({ error: "MiniMax provider not found" });
    await minimaxSettings.clear(request.params.providerId);
    return reply.code(204).send();
  });

  app.get("/settings/models/providers/volcengine-tts", async () => {
    const { ttsConfigured, defaultVoiceId } = doubaoVoiceSettings.get();
    return { configured: ttsConfigured, ...(defaultVoiceId ? { defaultVoiceId } : {}) };
  });
  app.put<{ Body: { apiKey?: string; defaultVoiceId?: string | null } }>("/settings/models/providers/volcengine-tts", { schema: { body: {
    type: "object", additionalProperties: false, minProperties: 1,
    properties: { apiKey: { type: "string", minLength: 1, maxLength: 10_000 }, defaultVoiceId: { anyOf: [{ type: "string", minLength: 1, maxLength: AUDIO_VOICE_ID_MAX_LENGTH, pattern: AUDIO_VOICE_ID_PATTERN }, { type: "null" }] } },
  } } }, async (request, reply) => {
    try {
      if (request.body.apiKey !== undefined) await doubaoVoiceSettings.setService("volcengine-tts", request.body.apiKey);
      if (request.body.defaultVoiceId !== undefined) await doubaoVoiceSettings.setDefaultVoice(request.body.defaultVoiceId);
      const { ttsConfigured, defaultVoiceId } = doubaoVoiceSettings.get();
      return { configured: ttsConfigured, ...(defaultVoiceId ? { defaultVoiceId } : {}) };
    }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.post<{ Body: { text: string; voiceId?: string; language?: string; style?: string; speed?: number } }>(
    "/settings/models/providers/volcengine-tts/preview",
    { schema: { body: {
      type: "object", additionalProperties: false, required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 500 },
        voiceId: { type: "string", minLength: 1, maxLength: AUDIO_VOICE_ID_MAX_LENGTH, pattern: AUDIO_VOICE_ID_PATTERN },
        language: { type: "string", minLength: 1, maxLength: 40 },
        style: { type: "string", minLength: 1, maxLength: 500 },
        speed: { type: "number", minimum: -50, maximum: 100 },
      },
    } } },
    async (request, reply) => {
      if (!providerEnabled("volcengine-tts")) return reply.code(409).send({ error: "The speech service is disabled" });
      try {
        const generated = await volcengineTtsProvider.generate({
          operation: "speech",
          model: { provider: "volcengine-tts", id: "seed-tts-2.0" },
          text: request.body.text,
          voiceId: request.body.voiceId,
          language: request.body.language,
          style: request.body.style,
          speed: request.body.speed,
          output: { format: "mp3", sampleRate: 24_000 },
        });
        reply.header("content-type", generated.mediaType);
        reply.header("cache-control", "no-store");
        if (generated.metadata?.providerRequestId) reply.header("x-provider-request-id", generated.metadata.providerRequestId);
        return reply.send(Buffer.from(generated.bytes));
      } catch (cause) {
        if (cause instanceof AudioGenerationError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );
  app.get("/settings/models/providers/volcengine-seed-audio", async () => ({ configured: doubaoVoiceSettings.get().seedConfigured }));
  app.put<{ Body: { apiKey: string } }>("/settings/models/providers/volcengine-seed-audio", { schema: apiKeySettingsSchema }, async (request, reply) => {
    try { await doubaoVoiceSettings.setService("volcengine-seed-audio", request.body.apiKey); return { configured: true }; }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.post<{ Body: { prompt: string; durationSeconds?: number } }>("/settings/models/providers/volcengine-seed-audio/preview", { schema: { body: { type: "object", additionalProperties: false, required: ["prompt"], properties: { prompt: { type: "string", minLength: 1, maxLength: 500 }, durationSeconds: { type: "number", minimum: 0.1, maximum: 5 } } } } }, async (request, reply) => {
    if (!providerEnabled("volcengine-seed-audio")) return reply.code(409).send({ error: "The audio service is disabled" });
    try {
      const generated = await volcengineSeedAudioProvider.generate({ operation: "sound-effect", model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" }, prompt: request.body.prompt, durationSeconds: request.body.durationSeconds, output: { format: "mp3", sampleRate: 48000 } });
      reply.header("content-type", generated.mediaType); reply.header("cache-control", "no-store"); return reply.send(Buffer.from(generated.bytes));
    } catch (cause) { if (cause instanceof AudioGenerationError) return reply.code(cause.statusCode).send({ error: cause.message }); throw cause; }
  });

  app.get("/settings/models/providers/openai/endpoint", async () => openAIEndpoint.get());

  const supportsResponsesTransport = async (providerId: string) => providerId === "openai"
    || (await providerModelSettings.customProvider(providerId))?.api === "openai-responses"
    || (await getModelRuntime()).getModels(providerId).some((model) => model.api === "openai-responses");
  app.get<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/transport", async (request, reply) => {
    if (!await supportsResponsesTransport(request.params.providerId)) return reply.code(404).send({ error: "Responses provider not found" });
    return { mode: providerModelSettings.responsesTransport(request.params.providerId) };
  });
  app.put<{ Params: { providerId: string }; Body: ResponsesTransportSettings }>("/settings/models/providers/:providerId/transport", {
    schema: { body: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { type: "string", enum: [...RESPONSES_TRANSPORT_MODES] } } } },
  }, async (request, reply) => {
    if (!await supportsResponsesTransport(request.params.providerId)) return reply.code(404).send({ error: "Responses provider not found" });
    try {
      await providerModelSettings.setResponsesTransport(request.params.providerId, request.body.mode);
      return { mode: providerModelSettings.responsesTransport(request.params.providerId) };
    }
    catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  const hasModelProvider = async (runtime: ModelRuntime, id: string) => isNative3DProvider(id) || Boolean(runtime.getProvider(id))
    || id.startsWith("cloud-") && cloudModels.hasProvider(id);
  const providerModels = async (runtime: ModelRuntime, providerId: string): Promise<ProviderModelSettings> => {
    if (isNative3DProvider(providerId)) {
      const native = native3DProviders.find(([id]) => id === providerId)!;
      return { models: providerModelSettings.models3D(providerId).map((definition) => ({
        provider: providerId, providerName: native[1], id: definition.id, name: definition.name, reasoningLevels: [], capabilities: ["3d"],
        visible: providerModelSettings.isVisible({ provider: providerId, id: definition.id }), custom: !model3DPreset(providerId, definition.id),
        source: model3DPreset(providerId, definition.id) ? "preset" : "custom", model3d: definition,
      })), defaultApi: providerId, canAddCustomModel: native[2].get().configured, model3DProtocol: providerId,
      catalogNotice: `Official presets · reviewed ${MODEL_3D_CATALOG_REVIEWED}. No model-list API; new versions arrive with app updates or can be added manually. Key access is determined by the provider.`,
      catalogDocsUrl: MODEL_3D_CATALOG_DOCS[providerId] };
    }
    if (providerId.startsWith("cloud-")) {
      void cloudModels.refresh();
      const catalog = cloudModels.catalogSnapshot();
      const provider = catalog.providers.find((provider) => provider.id === providerId);
      return { models: catalog.models.filter((model) => model.provider === providerId).map((model) => ({
        provider: providerId, providerName: provider?.name ?? providerId, id: model.id, name: model.name, reasoningLevels: [], capabilities: [model.capability],
        visible: providerModelSettings.isVisible(model), custom: false, source: "cloud",
        description: [model.estimatedCredits !== undefined && `${model.estimatedCredits} credits / generation`, model.maxReferenceImages && `up to ${model.maxReferenceImages} references`, model.polycount && `${model.polycount.min.toLocaleString()}–${model.polycount.max.toLocaleString()} faces`].filter(Boolean).join(" · "),
      })), defaultApi: "cloud", canAddCustomModel: false, catalogNotice: "Models and generation options are managed by OhMyGame. You can choose which models to show." };
    }
    const catalog = providerModelSettings.isCustom(providerId) ? customModelCatalog(runtime.getModels()) : new Map();
    const models = runtime.getModels(providerId).map((model) => providerModelSettings.resolveModel(model, catalog));
    const customProvider = await providerModelSettings.customProvider(providerId, catalog);
    const custom = customProvider?.models ?? await providerModelSettings.customModels(providerId);
    return {
      canRefreshCatalog: catalogRefresh.canRefresh(runtime, providerId),
      ...(catalogRefresh.refreshing(providerId) ? { refreshingCatalog: true } : {}),
      models: customProvider ? customProvider.models.map((model) => ({
        provider: providerId, providerName: customProvider.name, id: model.id, name: model.name,
        reasoningLevels: modelUsages(model).language ? supportedReasoningLevels(models.find((candidate) => candidate.id === model.id) ?? model) : [],
        visible: providerModelSettings.isVisible({ provider: providerId, id: model.id }), custom: true, capabilities: modelUsageList(model),
      })) : models.map((model) => ({
        provider: model.provider, providerName: runtime.getProvider(providerId)?.name ?? providerId,
        id: model.id, name: model.name, reasoningLevels: supportedReasoningLevels(model),
        visible: providerModelSettings.isVisible(model), custom: custom.some((item) => item.id === model.id),
      })),
      defaultApi: customProvider?.api ?? models[0]?.api ?? "openai-completions",
      defaultBaseUrl: runtime.getProvider(providerId)?.baseUrl ?? models[0]?.baseUrl,
      canAddCustomModel: runtime.hasConfiguredAuth(providerId) && !runtime.isUsingOAuth(providerId),
    };
  };

  app.get<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/models", async (request, reply) => {
    const runtime = await getModelRuntime();
    if (!await hasModelProvider(runtime, request.params.providerId)) return reply.code(404).send({ error: "Provider not found" });
    catalogRefresh.schedule(runtime, [request.params.providerId]);
    return providerModels(runtime, request.params.providerId);
  });

  app.post<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/models/refresh", async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId } = request.params;
    if (!catalogRefresh.canRefresh(runtime, providerId)) return reply.code(400).send({ error: "Connect and enable a built-in provider to refresh its catalog. Network access must be enabled." });
    try {
      await catalogRefresh.refresh(runtime, providerId, true);
      return await providerModels(runtime, providerId);
    } catch {
      return reply.code(503).send({ error: MODEL_CATALOG_REFRESH_ERROR });
    }
  });

  app.put<{ Params: { providerId: string }; Body: { ids: string[]; visible: boolean } }>("/settings/models/providers/:providerId/models/visibility", {
    schema: { body: { type: "object", additionalProperties: false, required: ["ids", "visible"], properties: { ids: { type: "array", minItems: 1, maxItems: 10_000, items: { type: "string", minLength: 1, maxLength: 200 } }, visible: { type: "boolean" } } } },
  }, async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId } = request.params;
    if (!await hasModelProvider(runtime, providerId)) return reply.code(404).send({ error: "Provider not found" });
    const custom = await providerModelSettings.customProvider(providerId);
    const known = new Set((await providerModels(runtime, providerId)).models.map((model) => model.id));
    if (request.body.ids.some((id) => !known.has(id))) return reply.code(400).send({ error: "Model not found" });
    if (request.body.visible && custom?.models.some((model) => request.body.ids.includes(model.id) && !modelUsageList(model).length)) return reply.code(400).send({ error: "Assign a use to the model before enabling it" });
    await providerModelSettings.setVisibility(providerId, request.body.ids, request.body.visible);
    return providerModels(runtime, providerId);
  });

  app.post<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/models/custom", async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId } = request.params;
    if (!await hasModelProvider(runtime, providerId)) return reply.code(404).send({ error: "Provider not found" });
    try {
      const settings = await providerModels(runtime, providerId);
      if (!settings.canAddCustomModel) return reply.code(400).send({ error: "Custom models require an API key connection" });
      if (isNative3DProvider(providerId)) {
        const model = normalizeNativeModel3D(providerId, request.body);
        if (settings.models.some((entry) => entry.id === model.id)) return reply.code(409).send({ error: "A model with this ID already exists" });
        await providerModelSettings.saveModel3D(providerId, model, true);
      } else {
        const model = normalizeCustomProviderModel(request.body, settings.defaultApi, settings.defaultBaseUrl, customModelCatalog(runtime.getModels()));
        if (runtime.getModel(providerId, model.id)) return reply.code(409).send({ error: "A model with this ID already exists" });
        await providerModelSettings.addCustomModel(providerId, model);
        await providerModelSettings.setVisibility(providerId, [model.id], true);
        await runtime.refresh({ allowNetwork: false, providers: [providerId] });
      }
      return reply.code(201).send(await providerModels(runtime, providerId));
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.put<{ Params: { providerId: string; modelId: string } }>("/settings/models/providers/:providerId/models/:modelId", async (request, reply) => {
    const { providerId, modelId } = request.params;
    if (!isNative3DProvider(providerId)) return reply.code(400).send({ error: "Use the custom provider editor for this connection" });
    if (!providerModelSettings.models3D(providerId).some((model) => model.id === modelId)) return reply.code(404).send({ error: "3D model not found" });
    try {
      const model = normalizeNativeModel3D(providerId, request.body);
      if (model.id !== modelId) return reply.code(400).send({ error: "Model IDs cannot be renamed. Add a new version instead." });
      await providerModelSettings.saveModel3D(providerId, model);
      return providerModels(await getModelRuntime(), providerId);
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.delete<{ Params: { providerId: string; modelId: string } }>("/settings/models/providers/:providerId/models/:modelId/overrides", async (request, reply) => {
    const { providerId, modelId } = request.params;
    if (!isNative3DProvider(providerId) || !model3DPreset(providerId, modelId)) return reply.code(404).send({ error: "Official model not found" });
    await providerModelSettings.removeModel3D(providerId, modelId, true);
    return providerModels(await getModelRuntime(), providerId);
  });

  app.delete<{ Params: { providerId: string; modelId: string } }>("/settings/models/providers/:providerId/models/custom/:modelId", async (request, reply) => {
    const runtime = await getModelRuntime();
    const { providerId, modelId } = request.params;
    if (!isNative3DProvider(providerId) && !runtime.getProvider(providerId)) return reply.code(404).send({ error: "Provider not found" });
    try {
      if (isNative3DProvider(providerId)) await providerModelSettings.removeModel3D(providerId, modelId);
      else {
        await providerModelSettings.removeCustomModel(providerId, modelId);
        await runtime.refresh({ allowNetwork: false, providers: [providerId] });
      }
      return providerModels(runtime, providerId);
    } catch (cause) { return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });

  app.put<{ Body: { baseUrl: string } }>(
    "/settings/models/providers/openai/endpoint",
    { schema: modelEndpointSchema },
    async (request, reply) => {
      try {
        const runtime = await getModelRuntime();
        const settings = await openAIEndpoint.update(request.body.baseUrl);
        await syncOpenAIEndpoint(runtime);
        return settings;
      } catch (cause) {
        return reply.code(400).send({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
  );

  app.post<{ Params: { providerId: string }; Body: { method: ModelAuthMethod } }>(
    "/settings/models/providers/:providerId/login",
    { schema: modelAuthLoginSchema },
    async (request, reply) => {
      try {
        return reply.code(202).send({ operationId: await modelAuth.start(request.params.providerId, request.body.method) });
      } catch (cause) {
        if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.post<{ Params: { operationId: string }; Body: { promptId: string; value: string } }>(
    "/settings/model-auth/:operationId/respond",
    { schema: modelAuthResponseSchema },
    async (request, reply) => {
      try {
        modelAuth.respond(request.params.operationId, request.body.promptId, request.body.value);
        return reply.code(204).send();
      } catch (cause) {
        if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.delete<{ Params: { operationId: string } }>("/settings/model-auth/:operationId", async (request, reply) => {
    try {
      modelAuth.cancel(request.params.operationId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });

  app.delete<{ Params: { providerId: string } }>("/settings/models/providers/:providerId/credential", async (request, reply) => {
    try {
      await modelAuth.logout(request.params.providerId);
      return reply.code(204).send();
    } catch (cause) {
      if (cause instanceof ModelAuthError) return reply.code(cause.statusCode).send({ error: cause.message });
      throw cause;
    }
  });
}
