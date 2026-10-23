/** Media files that workspaces and the Library recognize, by lower-case extension. */
export const MEDIA_FILE_TYPES = {
  ".avif": { mediaType: "image", contentType: "image/avif" },
  ".gif": { mediaType: "image", contentType: "image/gif" },
  ".jpeg": { mediaType: "image", contentType: "image/jpeg" },
  ".jpg": { mediaType: "image", contentType: "image/jpeg" },
  ".png": { mediaType: "image", contentType: "image/png" },
  ".svg": { mediaType: "image", contentType: "image/svg+xml" },
  ".webp": { mediaType: "image", contentType: "image/webp" },
  ".m4a": { mediaType: "audio", contentType: "audio/mp4" },
  ".mp3": { mediaType: "audio", contentType: "audio/mpeg" },
  ".ogg": { mediaType: "audio", contentType: "audio/ogg" },
  ".wav": { mediaType: "audio", contentType: "audio/wav" },
  ".mp4": { mediaType: "video", contentType: "video/mp4" },
  ".mov": { mediaType: "video", contentType: "video/quicktime" },
  ".webm": { mediaType: "video", contentType: "video/webm" },
  ".glb": { mediaType: "model", contentType: "model/gltf-binary" },
} as const satisfies Record<
  string,
  { mediaType: "image" | "video" | "audio" | "model"; contentType: string }
>;

export type MediaFileInfo =
  (typeof MEDIA_FILE_TYPES)[keyof typeof MEDIA_FILE_TYPES];
export type MediaContentType = MediaFileInfo["contentType"];

export const MEDIA_CONTENT_TYPES: readonly MediaContentType[] = [
  ...new Set(Object.values(MEDIA_FILE_TYPES).map((info) => info.contentType)),
];

/** The extension of a file name or path, matching Node's `path.extname`, so `.png` alone has none. */
export function fileExtension(name: string): string {
  const base = name.slice(
    Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1,
  );
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

export function mediaFileInfo(name: string): MediaFileInfo | undefined {
  const extension = fileExtension(name).toLowerCase();
  return Object.hasOwn(MEDIA_FILE_TYPES, extension)
    ? MEDIA_FILE_TYPES[extension as keyof typeof MEDIA_FILE_TYPES]
    : undefined;
}
