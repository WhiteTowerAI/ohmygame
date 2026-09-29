import type { AssetCanvasDocument } from "./contracts.js";

export interface AssetCanvasCoverSource {
  assetId: string;
  mediaType: "image" | "video";
}

/** Finds the last available image/video in an Asset Canvas document. */
export function findAssetCanvasCoverSource(document: AssetCanvasDocument): AssetCanvasCoverSource | undefined {
  for (let index = document.nodes.length - 1; index >= 0; index -= 1) {
    const node = document.nodes[index];
    if (!node) continue;
    if (node.type === "asset" && (node.data.mediaType === "image" || node.data.mediaType === "video")) {
      return { assetId: node.data.assetId, mediaType: node.data.mediaType };
    }
    if (node.type === "image" && node.data.assetId) return { assetId: node.data.assetId, mediaType: "image" };
    if (node.type === "video" && node.data.assetId) return { assetId: node.data.assetId, mediaType: "video" };
  }
  return undefined;
}
