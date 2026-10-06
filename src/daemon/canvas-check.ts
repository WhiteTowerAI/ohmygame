import { canvasNodeAssetIds } from "../shared/canvas-assets.js";
import { resolveAssetCanvasAssetId } from "../shared/asset-canvas.js";
import type { CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";
import { readCanvasBoard, readCanvasIndex, readCanvasDocument } from "./canvas-workspace.js";
import { canvasAssetCatalog, readCanvasAssets } from "./canvas-assets.js";

export interface CanvasCheckIssue { file: string; message: string }
export interface CanvasCheckResult { ok: boolean; issues: CanvasCheckIssue[] }

export async function checkCanvasWorkspace(workspace: string): Promise<CanvasCheckResult> {
  const issues: CanvasCheckIssue[] = [];
  const inspect = async <T>(file: string, operation: () => Promise<T>): Promise<T | undefined> => {
    try { return await operation(); }
    catch (cause) { issues.push({ file, message: cause instanceof Error ? cause.message : String(cause) }); return undefined; }
  };
  const index = await inspect("canvas/index.json", () => readCanvasIndex(workspace));
  if (!index) {
    if (!issues.length) issues.push({ file: "canvas/index.json", message: "No canvas workspace exists. Create index.json and the files it references." });
    return { ok: false, issues };
  }
  const manifest = await inspect("canvas/assets.json", () => readCanvasAssets(workspace));
  const assets = new Map<string, CanvasAssetCatalogEntry>();
  if (manifest) for (const [id, asset] of Object.entries(manifest.assets)) {
    const result = await inspect(`canvas/assets.json /assets/${id}`, () => canvasAssetCatalog(workspace, { version: 1, assets: { [id]: asset } }));
    if (result?.[0]) assets.set(id, result[0]);
  }
  for (const document of index.documents) await inspect(`canvas/documents/${document.id}.md`, () => readCanvasDocument(workspace, document.id));
  const documentIds = new Set(index.documents.map((document) => document.id));
  for (const entry of index.boards) {
    const file = `canvas/boards/${entry.id}.json`, detail = await inspect(file, () => readCanvasBoard(workspace, entry.id));
    if (!detail) { if (!issues.some((issue) => issue.file === file)) issues.push({ file, message: "Board file is missing" }); continue; }
    for (const node of detail.board.nodes) if (node.type === "document" && !documentIds.has(node.data.documentId)) issues.push({ file, message: `Node ${node.id}: unknown document ${node.data.documentId}` });
    if (manifest) for (const id of canvasNodeAssetIds(detail.board.nodes)) if (!manifest.assets[id]) issues.push({ file, message: `Asset ${id} is not registered in canvas/assets.json` });
    for (const node of detail.board.nodes) {
      const outputId = "assetId" in node.data ? node.data.assetId : undefined;
      const output = outputId ? assets.get(outputId) : undefined;
      const expected = node.type === "asset" ? node.data.mediaType : node.type === "model-3d" || node.type === "animate-3d" ? "model" : node.type;
      if (output && output.mediaType !== expected) issues.push({ file, message: `Node ${node.id}: output asset must be ${expected}, found ${output.mediaType}` });
      const references = node.type === "image" || node.type === "model-3d" ? node.data.images : node.type === "video" ? node.data.references : node.type === "animate-3d" && node.data.source ? [node.data.source] : [];
      for (const reference of references) {
        const id = resolveAssetCanvasAssetId(detail.board.nodes, reference), asset = id ? assets.get(id) : undefined;
        if (!asset) continue;
        const allowed = node.type === "animate-3d" ? asset.contentType === "model/gltf-binary" : node.type === "video" ? asset.mediaType === "image" : node.type === "model-3d" ? ["image/png", "image/jpeg", "image/webp"].includes(asset.contentType) : ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.contentType);
        if (!allowed) issues.push({ file, message: `Node ${node.id}: reference ${id} has unsupported media type ${asset.contentType}` });
      }
    }
  }
  return { ok: !issues.length, issues };
}
