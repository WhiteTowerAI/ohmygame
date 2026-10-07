import type { CustomProviderModel, DiscoveredProviderModels } from "../shared/contracts.js";
import { normalizeCustomProvider } from "./provider-model-settings.js";

const MAX_MODELS = 2_000;
const MAX_PAGES = 20;

/** Reads the submitted endpoint without saving the provider or its credentials. */
export async function discoverProviderModels(value: unknown, request: typeof fetch = fetch): Promise<DiscoveredProviderModels> {
  if (!isObject(value)) throw new Error("Invalid provider connection");
  const settings = normalizeCustomProvider({ ...value, name: "Model discovery", models: undefined, hiddenModelIds: undefined });
  if (settings.authentication === "api_key" && !settings.apiKey) throw new Error("API key is required");
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
      const model = discoveredModel(entry, settings.api);
      if (model) models.set(model.id, model);
      if (models.size >= MAX_MODELS) return { models: [...models.values()], truncated: true };
    }
    cursor = isObject(body) ? (settings.api === "anthropic-messages" && body.has_more === true ? string(body.last_id) : settings.api === "google-generative-ai" ? string(body.nextPageToken) : undefined) : undefined;
    if (isObject(body) && settings.api === "anthropic-messages" && body.has_more === true && !cursor) throw new Error("The endpoint returned an invalid model page. Add model IDs manually.");
    if (!cursor) return { models: [...models.values()] };
    if (cursors.has(cursor)) throw new Error("The endpoint returned an invalid model page. Add model IDs manually.");
    cursors.add(cursor);
  }
  return { models: [...models.values()], truncated: true };
}

function discoveredModel(value: unknown, api: string): CustomProviderModel | undefined {
  if (!isObject(value)) return undefined;
  const google = api === "google-generative-ai";
  const rawId = string(google ? value.name : value.id);
  const id = google ? rawId?.replace(/^models\//, "") : rawId;
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id)) return undefined;
  if (google && Array.isArray(value.supportedGenerationMethods) && !value.supportedGenerationMethods.includes("generateContent")) return undefined;
  const architecture = isObject(value.architecture) ? value.architecture : undefined;
  if (Array.isArray(architecture?.output_modalities) && !architecture.output_modalities.includes("text")) return undefined;
  const name = (string(value.displayName) ?? string(value.display_name) ?? string(value.name) ?? id).slice(0, 200);
  const contextWindow = tokenLimit(value.contextWindow ?? value.context_length ?? value.inputTokenLimit) ?? 128_000;
  const topProvider = isObject(value.top_provider) ? value.top_provider : undefined;
  const maxTokens = Math.min(contextWindow, tokenLimit(value.maxTokens ?? value.max_tokens ?? value.outputTokenLimit ?? topProvider?.max_completion_tokens) ?? 16_384);
  return {
    id, name, api, contextWindow, maxTokens,
    reasoning: value.reasoning === true || (Array.isArray(value.supported_parameters) && value.supported_parameters.includes("reasoning")),
    supportsImages: Array.isArray(architecture?.input_modalities) ? architecture.input_modalities.includes("image") : Array.isArray(value.input) && value.input.includes("image"),
  };
}

function tokenLimit(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
