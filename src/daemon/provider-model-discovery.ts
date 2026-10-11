import { AGENT_REASONING_LEVELS, type CustomProviderModel, type CustomThinkingLevelMap, type DiscoveredProviderModels, type CustomProviderPreset, type CustomModelUsages } from "../shared/contracts.js";
import { defaultImageSettings, defaultModel3DSettings, defaultVideoSettings } from "../shared/custom-models.js";
import { listOpenRouterImageModels, listOpenRouterVideoModels } from "./openrouter-media.js";
import { normalizeCustomProvider } from "./provider-model-settings.js";
import { automaticCustomReasoning, knownCustomModel, normalizeThinkingLevelMap, type CustomModelCatalog } from "./custom-model-capabilities.js";
import { imageModelDefinition } from "./image-models.js";
import { MODEL_3D_PRESETS, model3DPreset, usesModel3DPresets, type Native3DProviderId } from "../shared/model3d-presets.js";

const MAX_MODELS = 2_000;
const MAX_PAGES = 20;

/** Reads the submitted endpoint without saving the provider or its credentials. */
export async function discoverProviderModels(value: unknown, request: typeof fetch = fetch, catalog: CustomModelCatalog = new Map()): Promise<DiscoveredProviderModels> {
  if (!isObject(value)) throw new Error("Invalid provider connection");
  const settings = normalizeCustomProvider({ ...value, name: "Model discovery", models: undefined, hiddenModelIds: undefined });
  if (settings.authentication === "api_key" && !settings.apiKey) throw new Error("API key is required");
  if (usesModel3DPresets(settings.baseUrl, settings.preset)) return {
    source: "presets", models: MODEL_3D_PRESETS[settings.preset as Native3DProviderId].map((model) => ({
      id: model.id, name: model.name, api: settings.api, contextWindow: 128_000, maxTokens: 16_384,
      reasoning: false, supportsImages: false, usages: { "3d": model.settings },
    })), warnings: ["Loaded official presets. This does not check API-key access; add other compatible versions manually."],
  };
  if (settings.api === "google-vertex") throw new Error("This protocol does not offer a compatible model list. Add model IDs manually.");
  const headers: Record<string, string> = { accept: "application/json" };
  if (settings.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  if (settings.authentication === "api_key") {
    const header = settings.api === "anthropic-messages" ? "x-api-key" : settings.api === "google-generative-ai" ? "x-goog-api-key" : "authorization";
    headers[header] = header === "authorization" ? `Bearer ${settings.apiKey}` : settings.apiKey!;
  }
  const signal = AbortSignal.timeout(15_000);
  const models = new Map<string, CustomProviderModel>();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${settings.baseUrl}/models`);
    if (settings.api === "anthropic-messages") {
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("after_id", cursor);
    } else if (settings.api === "google-generative-ai") {
      url.searchParams.set("pageSize", "100");
      if (cursor) url.searchParams.set("pageToken", cursor);
    }
    let response: Response;
    try { response = await request(url, { headers, signal, redirect: "error" }); }
    catch { throw new Error(signal.aborted ? "Fetching models timed out. Retry or add a model manually." : "Could not reach the model endpoint. Check the Base URL or add a model manually."); }
    if (!response.ok) throw new Error(`Fetching models failed (HTTP ${response.status}). Check the endpoint and API key, or add a model manually.`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("The endpoint did not return a model list. Add model IDs manually."); }
    const entries = isObject(body) ? (settings.api === "google-generative-ai" ? body.models : body.data) : undefined;
    if (!Array.isArray(entries)) throw new Error("The endpoint did not return a compatible model list. Add model IDs manually.");
    for (const entry of entries) {
      const model = discoveredModel(entry, settings.api, catalog, settings.preset);
      if (model) models.set(model.id, model);
      if (models.size >= MAX_MODELS) return { models: [...models.values()], truncated: true };
    }
    cursor = isObject(body) ? (settings.api === "anthropic-messages" && body.has_more === true ? string(body.last_id) : settings.api === "google-generative-ai" ? string(body.nextPageToken) : undefined) : undefined;
    if (isObject(body) && settings.api === "anthropic-messages" && body.has_more === true && !cursor) throw new Error("The endpoint returned an invalid model page. Add model IDs manually.");
    if (!cursor) {
      const warnings: string[] = [];
      if (settings.preset === "openrouter") {
        const source = { baseUrl: settings.baseUrl, apiKey: settings.apiKey ?? "", headers: {}, authentication: settings.authentication };
        const media = await Promise.allSettled([listOpenRouterImageModels(source, request, signal), listOpenRouterVideoModels(source, request, signal)]);
        for (let index = 0; index < media.length; index++) {
          const result = media[index];
          if (result.status === "rejected") { warnings.push(`Could not fetch ${index === 0 ? "image" : "video"} models. Add their IDs manually.`); continue; }
          for (const item of result.value) {
            if (models.size >= MAX_MODELS && !models.has(item.id)) return { models: [...models.values()], truncated: true, warnings };
            const previous = models.get(item.id) ?? discoveredModel({ id: item.id, name: item.name }, settings.api, catalog, settings.preset)!;
            if ("generationOptions" in item) previous.usages = { ...previous.usages, image: {
              protocol: "openrouter-images", resolutions: [...new Set(item.generationOptions.map((option) => option.resolution))],
              aspectRatios: [...new Set(item.generationOptions.map((option) => option.aspectRatio))],
              maxReferenceImages: Math.min(14, item.maxReferenceImages ?? 0), maxOutputs: item.maxOutputs,
            } };
            else previous.usages = { ...previous.usages, video: { protocol: "openrouter-videos", resolutions: [...item.resolutions],
              aspectRatios: [...item.aspectRatios], durations: [...item.durations], maxReferenceImages: item.maxImageReferences,
              referenceModes: [...(item.referenceModes ?? [item.imageReferenceMode ?? "reference"])] } };
            models.set(item.id, previous);
          }
        }
      }
      return { models: [...models.values()], ...(warnings.length ? { warnings } : {}) };
    }
    if (cursors.has(cursor)) throw new Error("The endpoint returned an invalid model page. Add model IDs manually.");
    cursors.add(cursor);
  }
  return { models: [...models.values()], truncated: true };
}

function discoveredModel(value: unknown, api: string, catalog: CustomModelCatalog, preset?: CustomProviderPreset): CustomProviderModel | undefined {
  if (!isObject(value)) return undefined;
  const google = api === "google-generative-ai";
  const rawId = string(google ? value.name : value.id);
  const id = google ? rawId?.replace(/^models\//, "") : rawId;
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id)) return undefined;
  const architecture = isObject(value.architecture) ? value.architecture : undefined;
  const name = (string(value.displayName) ?? string(value.display_name) ?? string(value.name) ?? id).slice(0, 200);
  const known = knownCustomModel(id, api, catalog);
  const usages: CustomModelUsages = {};
  const outputs = Array.isArray(architecture?.output_modalities) ? architecture.output_modalities : [];
  const image = imageModelDefinition(id);
  if (outputs.includes("text") || (!outputs.length && (known || preset === "ollama" || preset === "lmstudio" || api === "anthropic-messages" || (google && Array.isArray(value.supportedGenerationMethods) && value.supportedGenerationMethods.includes("generateContent"))))) usages.language = true;
  if (image || outputs.includes("image")) {
    const protocol = preset === "openrouter" ? "openrouter-images" : preset === "seedance" ? "volcengine-images" : google ? "gemini-generate-content" : image?.protocol ?? "openai-images";
    usages.image = image ? { protocol, resolutions: [...new Set(image.generationOptions.map((option) => option.resolution))],
      aspectRatios: [...new Set(image.generationOptions.map((option) => option.aspectRatio))], maxReferenceImages: Math.min(14, image.maxReferenceImages ?? 1), maxOutputs: image.maxOutputs } : defaultImageSettings(protocol);
  }
  if (outputs.includes("video")) usages.video = defaultVideoSettings(preset === "seedance" ? "seedance" : "openrouter-videos");
  if (outputs.includes("3d") || outputs.includes("model") || preset === "meshy" || preset === "tripo" || preset === "hyper3d") usages["3d"] = model3DPreset(preset ?? "meshy", id)?.settings ?? defaultModel3DSettings("standard", preset === "tripo" ? "tripo" : preset === "hyper3d" ? "hyper3d" : "meshy");
  const contextWindow = tokenLimit(value.contextWindow ?? value.context_length ?? value.inputTokenLimit) ?? known?.contextWindow ?? 128_000;
  const topProvider = isObject(value.top_provider) ? value.top_provider : undefined;
  const maxTokens = Math.min(contextWindow, tokenLimit(value.maxTokens ?? value.max_tokens ?? value.outputTokenLimit ?? topProvider?.max_completion_tokens) ?? known?.maxTokens ?? 16_384);
  const reported = reportedThinkingLevelMap(value);
  const reasoning = typeof value.reasoning === "boolean" ? value.reasoning
    : reported ? true
    : Array.isArray(value.supported_parameters) ? value.supported_parameters.some((parameter) => parameter === "reasoning" || parameter === "reasoning_effort")
    : known?.reasoning ?? false;
  const reasoningCapabilities = automaticCustomReasoning(id, api, catalog, reported);
  return {
    id, name, api, contextWindow, maxTokens, usages,
    reasoning,
    ...(reasoningCapabilities ? { reasoningCapabilities } : {}),
    supportsImages: Array.isArray(architecture?.input_modalities) ? architecture.input_modalities.includes("image")
      : Array.isArray(value.input) ? value.input.includes("image") : known?.input.includes("image") ?? false,
  };
}

function reportedThinkingLevelMap(value: Record<string, unknown>): CustomThinkingLevelMap | undefined {
  const explicit = value.thinkingLevelMap ?? value.thinking_level_map;
  if (explicit !== undefined) return normalizeThinkingLevelMap(explicit);
  const parameters = isObject(value.supported_parameters) ? value.supported_parameters : undefined;
  const effort = isObject(parameters?.reasoning_effort) ? parameters.reasoning_effort : undefined;
  const values = value.supported_reasoning_efforts ?? effort?.values;
  if (!Array.isArray(values)) return undefined;
  const settings = new Set(values.filter((item): item is string => typeof item === "string"));
  const map = Object.fromEntries(AGENT_REASONING_LEVELS.map((level) => [level, settings.has(level) ? level : level === "off" && settings.has("none") ? "none" : level === "max" && settings.has("ultra") ? "ultra" : null]));
  return normalizeThinkingLevelMap(map);
}

function tokenLimit(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
