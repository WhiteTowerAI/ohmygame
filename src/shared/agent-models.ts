import type { AgentModelRef } from "./contracts.js";

export function findAgentModel<T extends AgentModelRef>(
  models: readonly T[],
  reference?: AgentModelRef,
): T | undefined {
  if (!reference) return undefined;
  return models.find((model) => model.provider === reference.provider && model.id === reference.id);
}

export function preferredAgentModel<T extends AgentModelRef>(
  models: readonly T[],
  selected?: AgentModelRef,
  configuredDefault?: AgentModelRef,
): T | undefined {
  return findAgentModel(models, selected) ?? findAgentModel(models, configuredDefault) ?? models[0];
}

/**
 * Models to start with after connecting a provider, from Pi's `defaultModelPerProvider`,
 * which the package does not export. Covers the providers first-run setup lists first.
 */
const RECOMMENDED_AGENT_MODEL_IDS: Record<string, string> = {
  anthropic: "claude-opus-4-8",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  openai: "gpt-5.5",
  "openai-codex": "gpt-6.1-sol",
  openrouter: "moonshotai/kimi-k2.6",
};

export function recommendedAgentModel<T extends AgentModelRef>(
  models: readonly T[],
  provider: string,
): T | undefined {
  const providerModels = models.filter((model) => model.provider === provider);
  return findAgentModel(providerModels, { provider, id: RECOMMENDED_AGENT_MODEL_IDS[provider] ?? "" }) ?? providerModels[0];
}
