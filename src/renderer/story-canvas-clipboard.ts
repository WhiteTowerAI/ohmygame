import { STORY_CANVAS_GRID_SIZE } from "./story-canvas-alignment.js";

export function snapStoryCanvasPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(position.x / STORY_CANVAS_GRID_SIZE) * STORY_CANVAS_GRID_SIZE,
    y: Math.round(position.y / STORY_CANVAS_GRID_SIZE) * STORY_CANVAS_GRID_SIZE,
  };
}
