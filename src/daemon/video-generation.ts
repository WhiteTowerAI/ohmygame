import type { VideoAspectRatio, VideoGenerationReference, VideoModelRef, VideoResolution, VideoReferenceMode } from "../shared/contracts.js";

export interface VideoGenerationInput {
  prompt: string;
  referenceMode?: VideoReferenceMode;
  model?: VideoModelRef;
  references?: VideoReferenceAsset[];
  duration?: number;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
}

export interface GeneratedVideo {
  bytes: Buffer;
  mediaType: "video/mp4";
  requestId?: string;
}

export interface VideoGenerator {
  generate(input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo>;
}

export interface VideoReferenceAsset {
  type: VideoGenerationReference["type"];
  name: string;
  mediaType: string;
  absolutePath: string;
  duration?: number;
}

export class VideoGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}
