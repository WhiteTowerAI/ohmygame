/** Categories shown in the image node toolbar. Grid splitting has its own picker. */
export const MEDIA_TOOL_GROUPS = [
  { id: "image-processing", operations: ["ai-cutout", "crop-image"] },
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

/** Operations that consume the explicitly ordered image selection. */
export function isMultiImageOperation(operation: string): boolean {
  return (
    operation === "compose-gif" ||
    operation === "compose-image-layers" ||
    operation === "sort-frames" ||
    operation === "stitch-images" ||
    operation === "compose-video"
  );
}

// The agent and API retain independent processing functions beyond the toolbar.
export type CanvasMediaOperation =
  | (typeof MEDIA_TOOL_GROUPS)[number]["operations"][number]
  | "remove-green-screen"
  | "remove-blue-screen"
  | "remove-white-background"
  | "resize-image"
  | "outline-image"
  | "cutout-image"
  | "brush-retouch-image"
  | "sort-frames"
  | "stitch-images"
  | "split-image-grid"
  | "extract-video-frames"
  | "video-frame-strip";
