import { AGENT_REASONING_LEVELS, DISCOVERED_LANGUAGE_FIELDS, type DiscoveredProviderModel, type CustomProviderModel, type CustomThinkingLevelMap } from "../shared/contracts.js";
import { automaticThinkingLevelMap, compatibleReasoningProtocols, supportedReasoningLevels } from "../shared/reasoning.js";
import { modelUsages, normalizeModelUsages } from "../shared/custom-models.js";
import { t } from "./i18n.js";

export type ModelRow = { model: CustomProviderModel; enabled: boolean };

/** Missing ownership metadata means the saved values belong to the user. */
export function applyDiscoveredLanguageFields(model: CustomProviderModel, discovered: DiscoveredProviderModel): CustomProviderModel {
  const updated = { ...model };
  for (const field of discovered.reportedFields ?? []) {
    if (model.automaticFields?.includes(field)) Object.assign(updated, { [field]: discovered[field] });
  }
  if (model.automaticFields?.includes("maxTokens")) updated.maxTokens = Math.min(updated.contextWindow, updated.maxTokens);
  return updated;
}

export function mergeDiscoveredProviderModels(current: ModelRow[], discovered: DiscoveredProviderModel[], baseUrl?: string): ModelRow[] {
  const merged = new Map(current.map((row) => [row.model.id, row]));
  for (const result of discovered) {
    const { reportedFields: _, ...model } = result;
    const existing = merged.get(model.id);
    if (!existing) {
      merged.set(model.id, { model: { ...model, automaticFields: [...DISCOVERED_LANGUAGE_FIELDS] }, enabled: false });
      continue;
    }
    const saved = existing.model;
    if ((saved.baseUrl && saved.baseUrl !== baseUrl) || !compatibleReasoningProtocols(saved.api, model.api)) continue;
    const updated = saved.api === model.api ? applyDiscoveredLanguageFields(saved, result) : saved;
    merged.set(model.id, { ...existing, model: { ...updated, reasoningCapabilities: model.reasoningCapabilities,
      reportedAdaptiveThinking: model.reportedAdaptiveThinking ?? saved.reportedAdaptiveThinking } });
  }
  return [...merged.values()].sort((a, b) => a.model.name.localeCompare(b.model.name));
}

/** Endpoint changes invalidate remote metadata; compatible catalog defaults still apply. */
export function invalidateCustomModelCapabilities(model: CustomProviderModel, api = model.api): CustomProviderModel {
  const capabilities = model.reasoningCapabilities;
  const catalog = capabilities?.source === "catalog" ? capabilities.thinkingLevelMap : capabilities?.catalogThinkingLevelMap;
  return {
    ...model, api, reportedAdaptiveThinking: undefined,
    reasoningCapabilities: catalog && compatibleReasoningProtocols(model.api, api)
      ? { source: "catalog", thinkingLevelMap: catalog } : undefined,
  };
}

export function initialCustomThinkingLevelMap(model: CustomProviderModel): CustomThinkingLevelMap {
  const automatic = automaticThinkingLevelMap(model.reasoningCapabilities);
  const levels = supportedReasoningLevels({ reasoning: true, thinkingLevelMap: automatic });
  return Object.fromEntries(AGENT_REASONING_LEVELS.map((level) => [level, levels.includes(level) ? automatic?.[level] ?? (level === "off" ? "none" : level) : null]));
}

export function modelError(model: CustomProviderModel, enabled = false): string | undefined {
  if (!model.id.trim() || /[\s\x00-\x1f]/.test(model.id) || model.id.length > 200) return t("customProvider.errors.modelId");
  try { normalizeModelUsages(model.usages); } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
  if (enabled && !Object.values(modelUsages(model)).some(Boolean)) return t("customProvider.errors.chooseUse", { name: model.name || model.id });
  if (modelUsages(model).language && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 100_000_000 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow)) return t("customProvider.errors.tokenLimits", { name: model.name || model.id });
  if (model.thinkingLevelMap) {
    if (!supportedReasoningLevels({ reasoning: model.reasoning, thinkingLevelMap: { ...automaticThinkingLevelMap(model.reasoningCapabilities), ...model.thinkingLevelMap } }).length) return t("customProvider.errors.enableLevel", { name: model.name || model.id });
    if (Object.values(model.thinkingLevelMap).some((value) => value !== null && (!value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)))) return t("customProvider.errors.levelParameter", { name: model.name || model.id });
  }
}
