import { AGENT_REASONING_LEVELS, type CustomProviderModel, type CustomThinkingLevelMap } from "../shared/contracts.js";
import { compatibleReasoningProtocols, supportedReasoningLevels } from "../shared/reasoning.js";
import { modelUsages, normalizeModelUsages } from "../shared/custom-models.js";

export type ModelRow = { model: CustomProviderModel; enabled: boolean };

export function mergeDiscoveredProviderModels(current: ModelRow[], discovered: CustomProviderModel[]): ModelRow[] {
  const merged = new Map(current.map((row) => [row.model.id, row]));
  for (const model of discovered) {
    const existing = merged.get(model.id);
    merged.set(model.id, existing
      ? { ...existing, model: { ...existing.model, reasoningCapabilities: compatibleReasoningProtocols(existing.model.api, model.api) ? model.reasoningCapabilities : existing.model.reasoningCapabilities } }
      : { model, enabled: false });
  }
  return [...merged.values()].sort((a, b) => a.model.name.localeCompare(b.model.name));
}

/** Endpoint changes invalidate remote metadata; compatible catalog defaults still apply. */
export function invalidateCustomModelCapabilities(model: CustomProviderModel, api = model.api): CustomProviderModel {
  const capabilities = model.reasoningCapabilities;
  const catalog = capabilities?.source === "catalog" ? capabilities.thinkingLevelMap : capabilities?.catalogThinkingLevelMap;
  return {
    ...model, api,
    reasoningCapabilities: catalog && compatibleReasoningProtocols(model.api, api)
      ? { source: "catalog", thinkingLevelMap: catalog } : undefined,
  };
}

export function initialCustomThinkingLevelMap(model: CustomProviderModel): CustomThinkingLevelMap {
  const automatic = model.reasoningCapabilities?.thinkingLevelMap;
  const levels = supportedReasoningLevels({ reasoning: true, thinkingLevelMap: automatic });
  return Object.fromEntries(AGENT_REASONING_LEVELS.map((level) => [level, levels.includes(level) ? automatic?.[level] ?? (level === "off" ? "none" : level) : null]));
}

export function modelError(model: CustomProviderModel, enabled = false): string | undefined {
  if (!model.id.trim() || /[\s\x00-\x1f]/.test(model.id) || model.id.length > 200) return "Enter a model ID without spaces (up to 200 characters).";
  try { normalizeModelUsages(model.usages); } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
  if (enabled && !Object.values(modelUsages(model)).some(Boolean)) return `Choose a use for ${model.name || model.id} before enabling it.`;
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 100_000_000 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) return `Check the token limits for ${model.name || model.id}. Output tokens must not exceed the context window.`;
  if (model.thinkingLevelMap) {
    if (!supportedReasoningLevels({ reasoning: model.reasoning, thinkingLevelMap: { ...model.reasoningCapabilities?.thinkingLevelMap, ...model.thinkingLevelMap } }).length) return `Enable at least one reasoning level for ${model.name || model.id}.`;
    if (Object.values(model.thinkingLevelMap).some((value) => value !== null && (!value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)))) return `Enter a parameter for each enabled reasoning level in ${model.name || model.id}.`;
  }
}
