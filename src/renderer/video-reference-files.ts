import type { LibraryUploadMediaType, VideoGenerationReference } from "../shared/contracts.js";

export const VIDEO_REFERENCE_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,.mov,.mp3,.wav";
export const VIDEO_REFERENCE_LIMITS = { image: 9, video: 3, audio: 3 } as const;

export interface PreparedVideoReferenceFile {
  file: File;
  type: VideoGenerationReference["type"];
  mediaType: LibraryUploadMediaType;
  duration?: number;
}

export async function prepareVideoReferenceFile(file: File): Promise<PreparedVideoReferenceFile> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const selected = extension === "png" ? { type: "image", mediaType: "image/png" }
    : extension === "jpg" || extension === "jpeg" ? { type: "image", mediaType: "image/jpeg" }
      : extension === "webp" ? { type: "image", mediaType: "image/webp" }
        : extension === "mp4" ? { type: "video", mediaType: "video/mp4" }
          : extension === "mov" ? { type: "video", mediaType: "video/quicktime" }
            : extension === "mp3" ? { type: "audio", mediaType: "audio/mpeg" }
              : extension === "wav" ? { type: "audio", mediaType: "audio/wav" }
                : undefined;
  if (!selected) throw new Error("Use PNG, JPEG, WebP, MP4, MOV, MP3, or WAV references");
  const type = selected.type as VideoGenerationReference["type"];
  const maximum = type === "image" ? 30 * 1024 * 1024 : type === "video" ? 200 * 1024 * 1024 : 15 * 1024 * 1024;
  if (file.size > maximum) throw new Error(`${titleCase(type)} references must be no larger than ${maximum / 1024 / 1024} MB`);
  return {
    file,
    type,
    mediaType: selected.mediaType as LibraryUploadMediaType,
    ...(type === "image" ? {} : { duration: await readMediaFileDuration(file, type, true) }),
  };
}

export function validateVideoReferenceCounts(types: VideoGenerationReference["type"][]): void {
  for (const type of ["image", "video", "audio"] as const) {
    if (types.filter((candidate) => candidate === type).length > VIDEO_REFERENCE_LIMITS[type]) {
      throw new Error(`Select up to ${VIDEO_REFERENCE_LIMITS[type]} reference ${type}s`);
    }
  }
}

export function validateVideoReferenceDurations(
  existing: Array<Pick<VideoGenerationReference, "type"> & { duration?: number }>,
  added: Array<Pick<VideoGenerationReference, "type"> & { duration?: number }>,
): void {
  for (const type of ["video", "audio"] as const) {
    const references = [...existing, ...added].filter((reference) => reference.type === type);
    if (references.some((reference) => reference.duration !== undefined && (reference.duration < 2 || reference.duration > 15))) {
      throw new Error(`${titleCase(type)} references must be 2 to 15 seconds long`);
    }
    if (references.reduce((total, reference) => total + (reference.duration ?? 0), 0) > 15) {
      throw new Error(`Reference ${type}s must total no more than 15 seconds`);
    }
  }
}

export function validVideoReferenceCombination(references: Array<Pick<VideoGenerationReference, "type">>): boolean {
  return !references.some((reference) => reference.type === "audio")
    || references.some((reference) => reference.type === "image" || reference.type === "video");
}

export async function readMediaFileDuration(file: File, type: "video" | "audio", validateSeedance = false): Promise<number> {
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
    if (validateSeedance && (duration < 2 || duration > 15)) {
      throw new Error(`${titleCase(type)} references must be 2 to 15 seconds long`);
    }
    return duration;
  } finally {
    element.removeAttribute("src");
    element.load();
    URL.revokeObjectURL(url);
  }
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}
