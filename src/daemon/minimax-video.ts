import type { PromptImage } from "../shared/contracts.js";

const MODEL = "MiniMax-H3";
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 10 * 60_000;

export interface GeneratedVideo {
  bytes: Buffer;
  mediaType: "video/mp4";
  requestId?: string;
}

export interface VideoGenerator {
  generate(input: { prompt: string; image?: PromptImage; duration: number; size?: string }, signal?: AbortSignal): Promise<GeneratedVideo>;
}

export interface VideoSource {
  baseUrl: string;
  apiKey: string;
  modelIds: readonly string[];
}

export class VideoGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

/** Uses the OpenAI-compatible video API exposed by Portal/New API. */
export class PortalVideoGenerator implements VideoGenerator {
  constructor(
    private readonly source: () => VideoSource | undefined,
    private readonly request: typeof fetch = fetch,
  ) {}

  async generate(input: { prompt: string; image?: PromptImage; duration: number; size?: string }, signal?: AbortSignal): Promise<GeneratedVideo> {
    const source = this.source();
    if (!source || !source.modelIds.includes(MODEL)) throw new VideoGenerationError("The selected video model is not available", 503);

    const body = new FormData();
    body.set("model", MODEL);
    body.set("prompt", input.prompt);
    body.set("seconds", String(input.duration));
    if (input.size) body.set("size", input.size);
    if (input.image) {
      body.set("input_reference", new Blob([Buffer.from(input.image.data, "base64")], { type: input.image.mediaType }), `reference.${input.image.mediaType === "image/png" ? "png" : "jpg"}`);
    }

    const response = await this.request(endpoint(source.baseUrl, "/videos"), {
      method: "POST",
      headers: { authorization: `Bearer ${source.apiKey}` },
      body,
      signal,
    });
    const created = await json(response, "Video generation request failed");
    const requestId = string(created.id) ?? string(created.task_id);
    if (!requestId) throw new VideoGenerationError("Video provider returned no task ID");

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const resultResponse = await this.request(endpoint(source.baseUrl, `/videos/${encodeURIComponent(requestId)}`), {
        headers: { authorization: `Bearer ${source.apiKey}` },
        signal,
      });
      const result = await json(resultResponse, "Video status request failed");
      const status = string(result.status)?.toLowerCase();
      if (status === "completed" || status === "succeeded" || status === "success") {
        const videoUrl = httpUrl(result.video_url);
        const content = videoUrl
          ? await this.request(videoUrl, { signal })
          : await this.request(endpoint(source.baseUrl, `/videos/${encodeURIComponent(requestId)}/content`), {
              headers: { authorization: `Bearer ${source.apiKey}` },
              signal,
            });
        if (!content.ok) throw new VideoGenerationError(`Video download failed (${content.status})`, content.status);
        return { bytes: Buffer.from(await content.arrayBuffer()), mediaType: "video/mp4", requestId };
      }
      if (status === "failed" || status === "error" || status === "expired") {
        const error = record(result.error);
        throw new VideoGenerationError(string(error.message) ?? `Video generation ${status}`);
      }
      await delay(POLL_INTERVAL_MS, signal);
    }
    throw new VideoGenerationError("Video generation timed out", 504);
  }
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
