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
  /**
   * Keeps a submitted task under the generation's recovery id, so a retry
   * resumes it. A generation that succeeds leaves the vendor's result in it:
   * the caller clears it once the video is stored.
   */
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

import { isLoopbackHostname } from "../shared/local-debug.js";

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const DEFAULT_VIDEO_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class VideoGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

export function videoRequestSignal(
  signal?: AbortSignal,
  timeoutMs = DEFAULT_VIDEO_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isVideoRequestTimeout(cause: unknown, callerSignal?: AbortSignal): boolean {
  return !callerSignal?.aborted && Boolean(cause && typeof cause === "object" && (cause as { name?: unknown }).name === "TimeoutError");
}

export function safeVideoUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return undefined;
    if (parsed.protocol === "https:") return parsed.href;
    if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname.toLowerCase())) return parsed.href;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function readBoundedVideo(
  response: Response,
  provider: string,
  maxBytes = MAX_VIDEO_BYTES,
): Promise<Buffer> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && lengthHeader.trim() !== "") {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new VideoGenerationError(
        `${provider} video exceeds the ${maxBytes / (1024 * 1024)} MiB size limit`,
        502,
      );
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new VideoGenerationError(
        `${provider} video exceeds the ${maxBytes / (1024 * 1024)} MiB size limit`,
        502,
      );
    }
    return buffer;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new VideoGenerationError(
          `${provider} video exceeds the ${maxBytes / (1024 * 1024)} MiB size limit`,
          502,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function readDownloadedVideo(
  fetcher: () => Promise<Response>,
  provider: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const response = await fetcher();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new VideoGenerationError(`${provider} video download failed (${response.status})`, response.status);
    }
    return await readBoundedVideo(response, provider);
  } catch (cause) {
    if (cause instanceof VideoGenerationError) throw cause;
    if (isVideoRequestTimeout(cause, signal)) {
      throw new VideoGenerationError(`${provider} video download timed out`, 504);
    }
    if (signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) throw cause;
    throw new VideoGenerationError(`Could not reach ${provider}`, 502);
  }
}
