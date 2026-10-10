import { Type } from "typebox";
import type { AssetCanvasNode, LibraryAsset } from "./contracts.js";

export interface CanvasAsset {
  name: string;
  path: string;
  description?: string;
  prompt?: string;
  libraryAssetId?: string;
}
export interface CanvasAssetManifest { version: 1; assets: Record<string, CanvasAsset> }
export interface CanvasAssetCatalogEntry extends CanvasAsset, Omit<LibraryAsset, "name" | "prompt"> {}
export interface UnavailableCanvasAsset extends CanvasAsset {
  id: string;
  status: "missing" | "unavailable";
  message: string;
}

export const CANVAS_ASSETS_FILE = "canvas/assets.json";
export const CANVAS_ASSETS_SCHEMA = Type.Object({
  version: Type.Literal(1),
  assets: Type.Record(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,120}$" }), Type.Object({
    name: Type.String({ minLength: 1, maxLength: 200 }),
    path: Type.String({ minLength: 1, maxLength: 1000, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+" }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    prompt: Type.Optional(Type.String()),
    libraryAssetId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  }, { additionalProperties: false }), { maxProperties: 10_000 }),
}, { additionalProperties: false });

export function canvasNodeAssetIds(nodes: readonly AssetCanvasNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    if ("assetId" in node.data && node.data.assetId) ids.add(node.data.assetId);
    const references = node.type === "image" || node.type === "model-3d" ? node.data.images
      : node.type === "video" ? node.data.references : node.type === "animate-3d" && node.data.source ? [node.data.source] : [];
    for (const reference of references) if (reference.type === "library") ids.add(reference.assetId);
  }
  return [...ids];
}

export function canvasNodeTitle(node: AssetCanvasNode, documents: readonly { id: string; title: string }[] = [], assets: readonly { id: string; name: string }[] = [], tables: readonly { id: string; title: string }[] = []): string {
  if (node.title?.trim()) return node.title.trim();
  if (node.type === "document") return documents.find((doc) => doc.id === node.data.documentId)?.title || "Untitled document";
  if (node.type === "table") return tables.find((table) => table.id === node.data.tableId)?.title || "Table";
  if (node.type === "asset") return assets.find((asset) => asset.id === node.data.assetId)?.name || "Asset";
  if (node.type === "text") return node.data.text.trim().split("\n")[0]?.slice(0, 80) || "Text";
  return { image: "Image", video: "Video", "model-3d": "3D model", "animate-3d": "Animation" }[node.type];
}
