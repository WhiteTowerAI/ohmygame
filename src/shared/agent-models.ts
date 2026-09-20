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
