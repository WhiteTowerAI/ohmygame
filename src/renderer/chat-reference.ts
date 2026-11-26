import { createElement } from "react";
import type { PromptContext } from "../shared/contracts.js";
import { FileText, Layers3, MousePointer2, Plug, type IconComponent } from "./icons.js";

export interface ChatReference {
  text: string;
}

export function formatChatPrompt(reference: ChatReference, prompt: string): string {
  return `[Selected text]\n${reference.text.trim()}\n\n[User prompt]\n${prompt.trim()}`;
}

/** A piece of editor context the next message will carry, shown as a removable chip. */
export interface ChatContextChip {
  /** Tells chips apart, so one can be removed. */
  key: string;
  kind: PromptContext["kind"];
  label: string;
  detail?: string;
}

const CONTEXT_ICONS: Record<PromptContext["kind"], IconComponent> = {
  "design-document": FileText,
  "canvas-board": Layers3,
  "preview-element": MousePointer2,
  "plugin-panel": Plug,
};

export function PromptContextIcon({ kind }: { kind: PromptContext["kind"] }) {
  return createElement(CONTEXT_ICONS[kind], { size: 12 });
}
