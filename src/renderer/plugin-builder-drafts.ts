import type { AgentModelRef, AgentReasoningLevel } from "../shared/contracts.js";
import { parseReasoningLevel } from "../shared/reasoning.js";

export interface PluginBuilderInput {
  prompt: string;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
const PREFIX = "ohmygame.plugin-builder.input.v1:";
export function readPluginBuilderInput(id: string, storage?: Pick<Storage, "getItem">): PluginBuilderInput {
  try {
    const value = JSON.parse(storage?.getItem(PREFIX + id) ?? "null");
    if (!value || typeof value !== "object") return { prompt: "" };
    return {
      prompt: typeof value.prompt === "string" ? value.prompt : "",
      model: typeof value.model?.provider === "string" && typeof value.model?.id === "string" ? value.model : undefined,
      reasoningLevel: parseReasoningLevel(value.reasoningLevel),
    };
  } catch { return { prompt: "" }; }
}
export function savePluginBuilderInput(id: string, input: PluginBuilderInput, storage?: Pick<Storage, "setItem">): void {
  try { storage?.setItem(PREFIX + id, JSON.stringify(input)); } catch { /* The input still works when storage is unavailable. */ }
}
export function removePluginBuilderInput(id: string, storage?: Pick<Storage, "removeItem">): void {
  try { storage?.removeItem(PREFIX + id); } catch { /* Storage may be unavailable. */ }
}
