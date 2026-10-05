import type { AssetCanvasNode } from "../shared/contracts.js";
import { snapCanvasPosition } from "./canvas-alignment.js";

export function duplicateAssetCanvasNode(
  node: AssetCanvasNode,
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): AssetCanvasNode {
  const duplicate = {
    ...structuredClone(node),
    id,
    position: snapCanvasPosition(position),
  };
  if (duplicate.type === "image") {
    duplicate.data.promptSource = undefined;
    duplicate.data.images = duplicate.data.images.filter((image) => image.type === "library");
  }
  if (duplicate.type === "video") {
    duplicate.data.promptSource = undefined;
    duplicate.data.references = duplicate.data.references.filter((reference) => reference.type === "library");
  }
  if (duplicate.type === "animate-3d" && duplicate.data.source?.type === "node") delete duplicate.data.source;
  return duplicate;
}
