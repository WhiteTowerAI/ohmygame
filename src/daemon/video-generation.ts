import type { MediaTaskJournal } from "./media-task-journal.js";
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

export interface VideoGenerationOptions {
  /** Keeps a submitted task under the generation's recovery id, so a retry resumes it. */
  journal?: MediaTaskJournal;
}

export interface VideoGenerator {
  generate(input: VideoGenerationInput, signal?: AbortSignal, options?: VideoGenerationOptions): Promise<GeneratedVideo>;
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
