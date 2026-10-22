export const MEDIA_TOOL_GROUPS = [
  {
    id: "background-removal",
    operations: [
      "remove-green-screen",
      "remove-blue-screen",
      "remove-white-background",
    ],
  },
  {
    id: "image-processing",
    operations: [
      "resize-image",
      "outline-image",
      "crop-image",
      "cutout-image",
      "brush-retouch-image",
    ],
  },
  {
    id: "gif-frames",
    operations: [
      "extract-gif-frames",
      "compose-gif",
      "sort-frames",
      "stitch-images",
    ],
  },
] as const;

export type MediaToolGroupId = (typeof MEDIA_TOOL_GROUPS)[number]["id"];
export type MediaToolOperation = (typeof MEDIA_TOOL_GROUPS)[number]["operations"][number];
