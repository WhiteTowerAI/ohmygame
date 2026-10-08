import type { AgentModelRef, AgentReasoningLevel } from "./contracts.js";

export const CANVAS_INDEX_FILE = "canvas/index.json";
export const canvasDocumentPath = (id: string) => `canvas/documents/${id}.md`;
export interface CanvasMarkdownDocument { id: string; title: string; markdown: string }
export interface CanvasDocumentDetail { document: CanvasMarkdownDocument; revision: string }
export interface CanvasDocumentGenerationRequest { instruction: string; model?: AgentModelRef; reasoningLevel?: AgentReasoningLevel; revision: string }
export interface CanvasDocumentGenerationResponse { markdown: string; model: AgentModelRef; revision: string }
export function createCanvasDocument(title: string): CanvasMarkdownDocument {
  return { id: crypto.randomUUID(), title, markdown: "" };
}
export function mergeCanvasDocumentContent(base: CanvasMarkdownDocument, local: CanvasMarkdownDocument, remote: CanvasMarkdownDocument): CanvasMarkdownDocument | undefined {
  if (base.id !== local.id || base.id !== remote.id) return undefined;
  const merge = (before: string, ours: string, theirs: string) => ours === theirs || before === theirs ? ours : before === ours ? theirs : undefined;
  const title = merge(base.title, local.title, remote.title);
  const markdown = merge(base.markdown, local.markdown, remote.markdown);
  return title === undefined || markdown === undefined ? undefined : { ...local, title, markdown };
}
