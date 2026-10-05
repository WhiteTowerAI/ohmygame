import type { ProjectState, PromptContext } from "../shared/contracts.js";
import { DESIGN_INDEX_FILE, designDocumentPath, type GameDesignDetail } from "../shared/game-design.js";
import { readGameDesignDocuments, readDesignIndex } from "./game-design.js";

export function gameDesignReference(detail: GameDesignDetail): PromptContext {
  return {
    kind: "design-document",
    label: `${(detail.document.title || "Game design").slice(0, 189)} (${detail.revision.slice(0, 8)})`,
    text: [
      "The user explicitly referenced this game design snapshot for this message. It was captured from the saved Markdown source when the message was sent.",
      `Source: ${designDocumentPath(detail.document.id)}\nRevision: ${detail.revision}`,
      "Use this snapshot as the design context for the turn. The user's current request takes priority; mention relevant differences without changing the design unless asked. Before editing the design, reread the current Markdown source to preserve changes made since this snapshot.",
      "Image paths are relative to the Markdown file. Image links do not include image pixels. Read relevant images when evaluating visual direction.",
      `Document snapshot:\n${detail.document.markdown}`,
    ].join("\n\n"),
  };
}

export async function gameDesignMetadata(project: ProjectState, hadDesign = false): Promise<string | undefined> {
  if (project.type === "asset-canvas") return undefined;
  try {
    const index = await readDesignIndex(project.workspacePath);
    if (!index) return hadDesign ? `This project currently has no saved main game design in ${DESIGN_INDEX_FILE}. Do not rely on an earlier document snapshot as the current design.` : undefined;
    const documents = await readGameDesignDocuments(project.workspacePath, index);
    const detail = documents.find((document) => document.document.id === index.mainDocumentId);
    return [
      detail ? `Game design: ${JSON.stringify(detail.document.title)}. Source: ${designDocumentPath(detail.document.id)}. Revision: ${detail.revision}.` : "No main design document is selected.",
      `Design workspace index: ${DESIGN_INDEX_FILE}. Boards: ${JSON.stringify(index.boards)}. Documents: ${JSON.stringify(documents.map((document) => ({ title: document.document.title, source: designDocumentPath(document.document.id), revision: document.revision })))}`,
      "Read the main Markdown document for game implementation and relevant design discussion, then relevant additional documents and boards. Compare revisions with earlier project context and reread when they change. Casual conversation does not require reading the document. An explicit design snapshot in this message is the referenced version.",
    ].join("\n");
  } catch (cause) {
    return `The current game design could not be read: ${cause instanceof Error ? cause.message : String(cause)}. Inspect ${DESIGN_INDEX_FILE} if it is relevant to the request; do not assume an earlier snapshot is current.`;
  }
}
