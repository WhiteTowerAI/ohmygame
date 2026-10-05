import type { PromptContext, PromptContextLabel } from "../shared/contracts.js";

/**
 * Editor context travels with the private part of a prompt, after any local
 * attachments: the agent reads it, and the conversation shows only labels.
 */
const OPENING = "\n\n<editor-context>\n";
const CLOSING = "\n</editor-context>";
const INSTRUCTION = "The user sent this message from the editor with the context below. Treat it as what the message refers to.";

export function promptContextBlock(contexts: readonly PromptContext[], projectDesign?: string): string {
  if (!contexts.length && !projectDesign) return "";
  return `${OPENING}${JSON.stringify({ instruction: INSTRUCTION, items: contexts, ...(projectDesign ? { projectDesign } : {}) })}${CLOSING}`;
}

export function withProjectDesignContext(privateContext: string, projectDesign?: string): string {
  const { rest, block } = splitPromptContext(privateContext);
  const items: PromptContext[] = block ? JSON.parse(block.slice(OPENING.length, -CLOSING.length)).items : [];
  return `${rest}${promptContextBlock(items, projectDesign)}`;
}

/** Separates a trailing editor context block from the rest of a prompt. */
export function splitPromptContext(value: string): { rest: string; block: string } {
  const index = value.lastIndexOf(OPENING);
  if (index < 0 || !value.endsWith(CLOSING)) return { rest: value, block: "" };
  return { rest: value.slice(0, index), block: value.slice(index) };
}

/** The labels of the editor context in a prompt's private context. */
export function promptContextLabels(privateContext: string): PromptContextLabel[] {
  const { block } = splitPromptContext(privateContext);
  if (!block) return [];
  try {
    const parsed = JSON.parse(block.slice(OPENING.length, -CLOSING.length)) as { items?: unknown };
    return Array.isArray(parsed.items)
      ? parsed.items.flatMap((item): PromptContextLabel[] => isPromptContextLabel(item) ? [{ kind: item.kind, label: item.label }] : [])
      : [];
  } catch {
    return [];
  }
}

function isPromptContextLabel(value: unknown): value is PromptContextLabel {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PromptContextLabel>;
  return (item.kind === "playable-node" || item.kind === "playable-element" || item.kind === "playable-drawing" || item.kind === "playable-asset" || item.kind === "design-document") && typeof item.label === "string";
}
