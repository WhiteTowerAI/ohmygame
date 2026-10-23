/** Categories shown in the image node toolbar. Grid splitting has its own picker. */
export const MEDIA_TOOL_GROUPS = [
  { id: "image-processing", operations: ["ai-image-cutout", "crop-image"] },
  {
    id: "gif-frames",
    operations: [
      "extract-gif-frames",
      "compose-gif",
      "compose-video",
      "compose-image-layers",
    ],
  },
] as const;

export type CanvasMediaToolbarAction = CanvasMediaOperation | "ai-image-cutout";

/** Operations that consume the explicitly ordered image selection. */
export function isMultiImageOperation(operation: string): boolean {
  return (
    operation === "compose-gif" ||
    operation === "compose-image-layers" ||
    operation === "compose-video"
  );
}

// The agent and API retain independent processing functions beyond the toolbar.
export type CanvasMediaOperation =
  | "crop-image"
  | "extract-gif-frames"
  | "compose-gif"
  | "compose-video"
  | "compose-image-layers"
  | "split-image-grid"
  | "video-frame-strip";
