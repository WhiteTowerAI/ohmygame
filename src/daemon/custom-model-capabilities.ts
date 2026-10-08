import type { RuntimeModel } from "./agent.js";
import { AGENT_REASONING_LEVELS, type CustomReasoningCapabilities, type CustomThinkingLevelMap } from "../shared/contracts.js";
import { compatibleReasoningProtocols } from "../shared/reasoning.js";

export type CustomModelCatalog = ReadonlyMap<string, readonly RuntimeModel[]>;

/** Build once per operation so each relay model only searches matching catalog entries. */
export function customModelCatalog(models: readonly RuntimeModel[]): CustomModelCatalog {
  const catalog = new Map<string, RuntimeModel[]>();
  for (const model of models) {
    for (const id of [model.id, `${model.provider}/${model.id}`]) {
      const matches = catalog.get(id);
      if (matches) matches.push(model);
      else catalog.set(id, [model]);
    }
  }
  return catalog;
}

/** Relays often return only IDs; use an upstream catalog entry for missing metadata. */
export function knownCustomModel(id: string, api: string, catalog: CustomModelCatalog): RuntimeModel | undefined {
  const upstream = api === "anthropic-messages" ? "anthropic"
    : api === "google-generative-ai" || api === "google-vertex" ? "google" : "openai";
  const matches = catalog.get(id) ?? [];
  return matches.find((model) => model.provider === upstream)
    ?? matches.find((model) => !model.provider.startsWith("custom-") && model.api === api);
}

export function customThinkingLevelMap(model: RuntimeModel | undefined, api: string): RuntimeModel["thinkingLevelMap"] {
  return model && compatibleReasoningProtocols(model.api, api) ? model.thinkingLevelMap : undefined;
}

export function normalizeThinkingLevelMap(value: unknown): CustomThinkingLevelMap | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reasoning levels");
  const entries = Object.entries(value);
  if (entries.some(([level, setting]) => !AGENT_REASONING_LEVELS.some((known) => known === level)
    || setting !== null && (typeof setting !== "string" || !setting.trim() || setting.length > 100 || /[\x00-\x1f]/.test(setting)))) throw new Error("Invalid reasoning levels");
  return Object.fromEntries(entries.map(([level, setting]) => [level, typeof setting === "string" ? setting.trim() : setting]));
}

export function automaticCustomReasoning(id: string, api: string, catalog: CustomModelCatalog, reported?: CustomThinkingLevelMap): CustomReasoningCapabilities | undefined {
  const thinkingLevelMap = customThinkingLevelMap(knownCustomModel(id, api, catalog), api);
  if (reported) return { source: "provider", thinkingLevelMap: reported, ...(thinkingLevelMap ? { catalogThinkingLevelMap: thinkingLevelMap } : {}) };
  return thinkingLevelMap ? { source: "catalog", thinkingLevelMap } : undefined;
}

/** The same resolved model is used by selectors, validation, and the SDK request. */
export function resolveCustomModelCapabilities(model: RuntimeModel, catalog: CustomModelCatalog, reported?: CustomThinkingLevelMap): RuntimeModel {
  if (!model.reasoning) return model;
  const automatic = automaticCustomReasoning(model.id, model.api, catalog, reported)?.thinkingLevelMap;
  return automatic ? { ...model, thinkingLevelMap: { ...automatic, ...model.thinkingLevelMap } } : model;
}
