import type { StoryNode } from "../shared/contracts.js";
import { STORY_CANVAS_GRID_SIZE } from "./story-canvas-alignment.js";

export function snapStoryCanvasPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(position.x / STORY_CANVAS_GRID_SIZE) * STORY_CANVAS_GRID_SIZE,
    y: Math.round(position.y / STORY_CANVAS_GRID_SIZE) * STORY_CANVAS_GRID_SIZE,
  };
}

export function duplicateStoryNode(
  node: StoryNode,
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): StoryNode {
  const duplicate = {
    ...structuredClone(node),
    id,
    position: snapStoryCanvasPosition(position),
  };
  if (duplicate.type === "open-ui" || duplicate.type === "scene" || duplicate.type === "interaction" || duplicate.type === "choice" || duplicate.type === "ending") {
    duplicate.data.presentation.surface.source = undefined;
    duplicate.data.presentation.media.items = duplicate.data.presentation.media.items.filter((item) => item.source.type === "library");
  }
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
