import type { LibraryUploadMediaType } from "../shared/contracts.js";

export interface PreparedVideoReferenceFile {
  file: File;
  type: "image";
  mediaType: LibraryUploadMediaType;
}

export function prepareVideoReferenceFile(file: File): PreparedVideoReferenceFile {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const selected = extension === "png" ? { type: "image", mediaType: "image/png" }
    : extension === "jpg" || extension === "jpeg" ? { type: "image", mediaType: "image/jpeg" }
      : extension === "webp" ? { type: "image", mediaType: "image/webp" }
        : undefined;
  if (!selected) throw new Error("Use PNG, JPEG, or WebP references");
  const maximum = 30 * 1024 * 1024;
  if (file.size > maximum) throw new Error("Image references must be no larger than 30 MB");
  return {
    file,
    type: "image",
    mediaType: selected.mediaType as LibraryUploadMediaType,
  };
}

export async function readMediaFileDuration(file: File, type: "video" | "audio"): Promise<number> {
  const element = document.createElement(type);
  const url = URL.createObjectURL(file);
  try {
    element.preload = "metadata";
    element.src = url;
    const duration = await new Promise<number>((resolve, reject) => {
      element.onloadedmetadata = () => resolve(element.duration);
      element.onerror = () => reject(new Error(`Could not read the duration of ${file.name}`));
    });
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read the duration of ${file.name}`);
    return duration;
  } finally {
    element.removeAttribute("src");
    element.load();
    URL.revokeObjectURL(url);
  }
}
