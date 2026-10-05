import type { AgentModelRef } from "./contracts.js";

export const DESIGN_INDEX_FILE = "design/index.json";
export const designDocumentPath = (id: string) => `design/documents/${id}.md`;
export interface GameDesignDocument { id: string; title: string; markdown: string }
export interface GameDesignDetail { document: GameDesignDocument; revision: string }
export interface DesignDocumentGenerationRequest { instruction: string; model?: AgentModelRef; revision: string }
export interface DesignDocumentGenerationResponse { markdown: string; model: AgentModelRef; revision: string }
export function createGameDesign(title: string): GameDesignDocument {
  return { id: crypto.randomUUID(), title, markdown: "" };
}
export function mergeGameDesign(base: GameDesignDocument, local: GameDesignDocument, remote: GameDesignDocument): GameDesignDocument | undefined {
  if (base.id !== local.id || base.id !== remote.id) return undefined;
  const merge = (before: string, ours: string, theirs: string) => ours === theirs || before === theirs ? ours : before === ours ? theirs : undefined;
  const title = merge(base.title, local.title, remote.title);
  const markdown = merge(base.markdown, local.markdown, remote.markdown);
  return title === undefined || markdown === undefined ? undefined : { ...local, title, markdown };
}
