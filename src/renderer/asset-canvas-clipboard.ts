import type { AssetCanvasNode } from "../shared/contracts.js";
import { STORY_CANVAS_GRID_SIZE } from "./asset-canvas-alignment.js";

export function snapAssetCanvasPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(position.x / STORY_CANVAS_GRID_SIZE) * STORY_CANVAS_GRID_SIZE,
    y: Math.round(position.y / STORY_CANVAS_GRID_SIZE) * STORY_CANVAS_GRID_SIZE,
  };
}

export function duplicateAssetCanvasNode(
  node: AssetCanvasNode,
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): AssetCanvasNode {
  const duplicate = {
    ...structuredClone(node),
    id,
    position: snapAssetCanvasPosition(position),
  };
  if (duplicate.type === "image") {
    duplicate.data.promptSource = undefined;
    duplicate.data.images = duplicate.data.images.filter((image) => image.type === "library");
  }
  if (duplicate.type === "video") {
    duplicate.data.promptSource = undefined;
    duplicate.data.references = duplicate.data.references.filter((reference) => reference.type === "library");
  }
  return duplicate;
}
