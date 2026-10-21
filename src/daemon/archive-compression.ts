import path from "node:path";

// These formats already compress their contents. Deflating them again costs
// CPU for little size reduction, especially for projects with many videos.
const STORED_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".m4a",
  ".mp3",
  ".ogg",
  ".mp4",
  ".mov",
  ".webm",
  ".woff2",
  ".zip",
]);

export function compressArchiveFile(file: string): boolean {
  return !STORED_EXTENSIONS.has(path.extname(file).toLowerCase());
}
