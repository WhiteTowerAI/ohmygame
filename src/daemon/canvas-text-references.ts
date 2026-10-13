import { readFile, stat } from "node:fs/promises";
import type { AssetCanvasTextGenerationSource } from "../shared/contracts.js";
import { canvasNodeTitle } from "../shared/canvas-assets.js";
import { resolveAssetCanvasImageAssetId } from "../shared/asset-canvas.js";
import { readCanvasAssets } from "./canvas-assets.js";
import { CanvasError, readCanvasBoard, readCanvasDocument } from "./canvas-workspace.js";
import { getWorkspaceMedia } from "./workspace.js";
import type { TextGenerationReference } from "./text-generation.js";

/** Resolve direct dependencies only: a reference uses a node's current output. */
export async function resolveCanvasTextReferences(workspace: string, source: AssetCanvasTextGenerationSource, documentId?: string): Promise<TextGenerationReference[]> {
  const detail = await readCanvasBoard(workspace, source.boardId);
  const node = detail?.board.nodes.find((node) => node.id === source.nodeId);
  if (!node || (node.type !== "text" && node.type !== "document") ||
    (documentId ? node.type !== "document" || node.data.documentId !== documentId : node.type !== "text")) {
    throw new CanvasError("The generation node is missing or does not match the requested document");
  }
  const references = node.data.references ?? [];
  if (!references.length) return [];
  const nodes = detail!.board.nodes;
  const manifest = await readCanvasAssets(workspace);
  return Promise.all(references.map(async (reference): Promise<TextGenerationReference> => {
    const linked = nodes.find((candidate) => candidate.id === reference.nodeId)!;
    if (linked.type === "text") return { type: "text", label: canvasNodeTitle(linked), text: linked.data.text };
    if (linked.type === "document") {
      const document = await readCanvasDocument(workspace, linked.data.documentId);
      if (!document) throw new CanvasError(`Referenced document ${linked.data.documentId} is unavailable`);
      return { type: "text", label: canvasNodeTitle(linked, [document.document]), text: document.document.markdown };
    }
    const assetId = resolveAssetCanvasImageAssetId(nodes, reference);
    const asset = assetId ? manifest.assets[assetId] : undefined;
    if (!asset) throw new CanvasError("A referenced image node has no saved output. Generate it first.");
    const file = await getWorkspaceMedia(workspace, asset.path);
    if (file.contentType !== "image/png" && file.contentType !== "image/jpeg" && file.contentType !== "image/webp" && file.contentType !== "image/gif") {
      throw new CanvasError("Reference images must be PNG, JPEG, WebP or GIF");
    }
    if ((await stat(file.absolutePath)).size > 10 * 1024 * 1024) throw new CanvasError("Each reference image must be no larger than 10 MB");
    return { type: "image", label: canvasNodeTitle(linked, [], [{ id: assetId!, name: asset.name }]), image: {
      mediaType: file.contentType, data: (await readFile(file.absolutePath)).toString("base64"),
    } };
  }));
}
