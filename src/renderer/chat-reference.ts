import { createElement } from "react";
import type { PromptContext } from "../shared/contracts.js";
import { Box, Brush, MousePointer2, type IconComponent } from "./icons.js";

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
  "playable-node": Box,
  "playable-element": MousePointer2,
  "playable-drawing": Brush,
};

export function PromptContextIcon({ kind }: { kind: PromptContext["kind"] }) {
  return createElement(CONTEXT_ICONS[kind], { size: 12 });
}
