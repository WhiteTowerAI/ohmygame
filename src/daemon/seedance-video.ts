import type { VideoAspectRatio, VideoGenerationReference, VideoModelId, VideoResolution } from "../shared/contracts.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 10 * 60_000;

interface VideoGenerationInput {
  prompt: string;
  model: VideoModelId;
  references?: VideoReferenceAsset[];
  duration: number;
  resolution: VideoResolution;
  aspectRatio: VideoAspectRatio;
}

export interface GeneratedVideo {
  bytes: Buffer;
  mediaType: "video/mp4";
  requestId?: string;
}

export interface VideoGenerator {
  generate(input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo>;
}

export interface VideoSource {
  baseUrl: string;
  apiKey: string;
  modelIds: readonly string[];
  stageMedia(reference: VideoReferenceAsset, signal?: AbortSignal): Promise<StagedVideoReference>;
  removeMedia(id: string): Promise<void>;
}

export interface VideoReferenceAsset {
  type: VideoGenerationReference["type"];
  name: string;
  mediaType: string;
  absolutePath: string;
  duration?: number;
}

export interface StagedVideoReference {
  id: string;
  url: string;
}

export class VideoGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

/** Uses New API's unified video endpoint, which adapts the request to Seedance. */
export class ManagedVideoGenerator implements VideoGenerator {
  constructor(
    private readonly source: () => VideoSource | undefined,
    private readonly request: typeof fetch = fetch,
  ) {}

  async generate(input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo> {
    const source = this.source();
    if (!source || !source.modelIds.includes(input.model)) throw new VideoGenerationError("The selected video model is not available", 503);
    const staged: Array<StagedVideoReference & { type: VideoReferenceAsset["type"] }> = [];
    try {
      for (const reference of input.references ?? []) {
        signal?.throwIfAborted();
        staged.push({ ...await source.stageMedia(reference, signal), type: reference.type });
      }
      const response = await this.request(endpoint(source.baseUrl, "/video/generations"), {
        method: "POST",
        headers: { authorization: `Bearer ${source.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          seconds: String(input.duration),
          metadata: {
            resolution: input.resolution,
            ratio: input.aspectRatio,
            ...(staged.length ? { content: staged.map(contentItem) } : {}),
          },
        }),
        signal,
      });
      const created = await json(response, "Video generation request failed");
      const requestId = string(created.id) ?? string(created.task_id);
      if (!requestId) throw new VideoGenerationError("Video provider returned no task ID");

      const deadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const resultResponse = await this.request(endpoint(source.baseUrl, `/video/generations/${encodeURIComponent(requestId)}`), {
          headers: { authorization: `Bearer ${source.apiKey}` },
          signal,
        });
        const envelope = await json(resultResponse, "Video status request failed");
        if (string(envelope.code) && string(envelope.code) !== "success") {
          throw new VideoGenerationError(string(envelope.message) ?? "Video status request failed");
        }
        const result = record(envelope.data);
        const status = string(result.status)?.toLowerCase();
        if (status === "completed" || status === "succeeded" || status === "success") {
          const videoUrl = httpUrl(result.result_url);
          const content = videoUrl
            ? await this.request(videoUrl, { signal })
            : await this.request(endpoint(source.baseUrl, `/videos/${encodeURIComponent(requestId)}/content`), {
                headers: { authorization: `Bearer ${source.apiKey}` },
                signal,
              });
          if (!content.ok) throw new VideoGenerationError(`Video download failed (${content.status})`, content.status);
          return { bytes: Buffer.from(await content.arrayBuffer()), mediaType: "video/mp4", requestId };
        }
        if (status === "failed" || status === "failure" || status === "error" || status === "expired") {
          throw new VideoGenerationError(string(result.fail_reason) ?? `Video generation ${status}`);
        }
        await delay(POLL_INTERVAL_MS, signal);
      }
      throw new VideoGenerationError("Video generation timed out", 504);
    } catch (cause) {
      if (cause instanceof VideoGenerationError) throw cause;
      if (signal?.aborted) throw cause;
      throw new VideoGenerationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await Promise.allSettled(staged.map((reference) => source.removeMedia(reference.id)));
    }
  }
}

function contentItem(reference: StagedVideoReference & { type: VideoReferenceAsset["type"] }): Record<string, unknown> {
  const field = `${reference.type}_url`;
  return { type: field, [field]: { url: reference.url }, role: `reference_${reference.type}` };
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function json(response: Response, message: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new VideoGenerationError(`${message} (${response.status})`, response.status);
  return record(await response.json());
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const candidate = string(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
