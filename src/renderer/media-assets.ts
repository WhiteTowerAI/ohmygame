import type { CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";

/** A canvas asset as the canvas shows it: its entry in `canvas/assets.json`, with the file it names. */
export interface CanvasMedia extends CanvasAssetCatalogEntry { assetId: string }

export function canvasMedia(entry: CanvasAssetCatalogEntry): CanvasMedia {
  return { ...entry, assetId: entry.id };
}

/** Names a canvas download without renaming the project file. */
export function canvasAssetDownloadName(title: string | undefined, originalName: string, contentType = ""): string {
  const extension = originalName.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? (DOWNLOAD_EXTENSIONS[contentType] ? `.${DOWNLOAD_EXTENSIONS[contentType]}` : "");
  const stem = (name: string) => {
    const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "").trim();
    return (extension && clean.toLowerCase().endsWith(extension.toLowerCase()) ? clean.slice(0, -extension.length) : clean).replace(/^[.\s]+|[.\s]+$/g, "");
  };
  let name = stem(title ?? "") || stem(originalName) || "asset";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  // Reserve space for the real extension and avoid splitting Unicode characters.
  const encoder = new TextEncoder();
  let truncated = "", length = encoder.encode(extension).length;
  for (const character of name) {
    length += encoder.encode(character).length;
    if (length > 200) break;
    truncated += character;
  }
  return `${truncated.replace(/[.\s]+$/g, "")}${extension}`;
}

/** Saves an asset under its name, adding the extension its content implies when a rename dropped it. */
export function downloadAssetBlob(blob: Blob, name: string): void {
  const extension = DOWNLOAD_EXTENSIONS[blob.type];
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = extension && !/\.[a-z0-9]+$/i.test(name) ? `${name}.${extension}` : name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "model/gltf-binary": "glb",
};

/** A small picture, as pixel art is: shown whole, each pixel kept square instead of blurred. */
export function isPixelArt({ mediaType, width, height }: { mediaType: string; width?: number | undefined; height?: number | undefined }): boolean {
  return mediaType === "image" && !!width && !!height && width <= 128 && height <= 128;
}
