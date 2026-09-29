import type { PromptContext } from "../shared/contracts.js";

export interface ChatReference {
  text: string;
}

export function formatChatPrompt(reference: ChatReference, prompt: string): string {
  return `[Selected text]\n${reference.text.trim()}\n\n[User prompt]\n${prompt.trim()}`;
}

/** A piece of editor context the next message will carry, shown as a removable chip. */
export interface ChatContextChip {
  kind: PromptContext["kind"];
  label: string;
  detail?: string;
}
