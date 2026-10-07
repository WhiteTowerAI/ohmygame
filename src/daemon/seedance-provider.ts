import { readFile } from "node:fs/promises";
import { videoReferenceAspectRatios } from "../shared/video-references.js";
import type { VideoModel } from "../shared/contracts.js";
import {
  VideoGenerationError,
  type GeneratedVideo,
  type VideoGenerationInput,
  type VideoReferenceAsset,
} from "./video-generation.js";
import { SEEDANCE_PROVIDERS, type SeedanceProviderId } from "./seedance-models.js";

const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export class SeedanceProvider {
  constructor(
    private readonly providerId: SeedanceProviderId,
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    private readonly maxWaitMs = DEFAULT_MAX_WAIT_MS,
  ) {}

  async generate(model: VideoModel, input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo> {
    const key = this.apiKey();
    if (!key) throw new VideoGenerationError(`${this.definition.name} API key is not configured`, 503);
    const duration = input.duration ?? model.durations[0]!;
    const resolution = input.resolution ?? model.resolutions[0]!;
    const references = input.references ?? [];
    const referenceMode = input.referenceMode ?? "frame";
    if (referenceMode !== "frame" && referenceMode !== "reference") throw new VideoGenerationError("Unsupported video reference mode", 400);
    const availableRatios = videoReferenceAspectRatios(model, references.length, referenceMode);
    const aspectRatio = input.aspectRatio ?? availableRatios[0]!;
    validateInput(model, references, duration, resolution, aspectRatio, referenceMode === "frame" ? 2 : model.maxImageReferences, availableRatios);

    const content = await Promise.all([
      Promise.resolve({ type: "text" as const, text: input.prompt }),
      ...references.map((reference, index) => imageContent(reference, referenceMode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame")),
    ]);
    const created = await this.#json(`${this.definition.baseUrl}/contents/generations/tasks`, {
      method: "POST",
      headers: this.#headers(key, true),
      body: JSON.stringify({
        model: model.id,
        content,
        resolution: resolution === "4K" ? "4k" : resolution,
        ratio: aspectRatio,
        duration,
        generate_audio: false,
        watermark: false,
      }),
      signal,
    }, "video generation request failed");
    const requestId = string(created.id);
    if (!requestId) throw new VideoGenerationError(`${this.definition.name} returned no video task ID`);

    const deadline = Date.now() + this.maxWaitMs;
    const taskUrl = `${this.definition.baseUrl}/contents/generations/tasks/${encodeURIComponent(requestId)}`;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const task = await this.#json(taskUrl, { headers: this.#headers(key), signal }, "video status request failed");
      const state = string(task.status)?.toLowerCase();
      if (state === "succeeded") {
        const videoUrl = httpUrl(record(task.content).video_url);
        if (!videoUrl) throw new VideoGenerationError(`${this.definition.name} completed without a video URL`);
        const response = await this.request(videoUrl, { signal });
        if (!response.ok) throw new VideoGenerationError(`${this.definition.name} video download failed (${response.status})`, response.status);
        return { bytes: Buffer.from(await response.arrayBuffer()), mediaType: "video/mp4", requestId };
      }
      if (state === "failed" || state === "expired") {
        throw new VideoGenerationError(errorMessage(task.error) ?? `${this.definition.name} video generation ${state}`, 400);
      }
      await delay(this.pollIntervalMs, signal);
    }
    throw new VideoGenerationError(`${this.definition.name} video generation timed out`, 504);
  }

  get definition() {
    return SEEDANCE_PROVIDERS[this.providerId];
  }

  async #json(url: string, init: RequestInit, operation: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, init);
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new VideoGenerationError(`Could not reach ${this.definition.name}`, 502);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) return body;
    const detail = errorMessage(body.error) ?? string(body.message);
    if (response.status === 401 || response.status === 403) throw new VideoGenerationError(`${this.definition.name} credentials were rejected`, 503);
    if (response.status === 429) throw new VideoGenerationError(`${this.definition.name} video generation is temporarily rate limited`, 429);
    throw new VideoGenerationError(detail ? `${this.definition.name}: ${detail}` : `${this.definition.name} ${operation}`, response.status >= 500 ? 502 : 400);
  }

  #headers(apiKey: string, json = false): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }
}

function validateInput(
  model: VideoModel,
  references: VideoReferenceAsset[],
  duration: number,
  resolution: VideoModel["resolutions"][number],
  aspectRatio: VideoModel["aspectRatios"][number],
  maxReferences: number,
  availableRatios: VideoModel["aspectRatios"],
): void {
  if (!model.durations.includes(duration)) throw new VideoGenerationError("Video duration is not supported by the selected model", 400);
  if (!model.resolutions.includes(resolution)) throw new VideoGenerationError("Video resolution is not supported by the selected model", 400);
  if (!availableRatios.includes(aspectRatio)) throw new VideoGenerationError("Video aspect ratio is not supported by the selected model and reference mode", 400);
  if (references.some((reference) => reference.type !== "image")) throw new VideoGenerationError("Official Seedance providers currently support image references only", 400);
  if (references.length > maxReferences) throw new VideoGenerationError(`The selected video mode supports up to ${maxReferences} reference images`, 400);
}

async function imageContent(reference: VideoReferenceAsset, role: "first_frame" | "last_frame" | "reference_image") {
  const data = await readFile(reference.absolutePath);
  const mediaType = reference.mediaType.toLowerCase();
  if (!mediaType.startsWith("image/")) throw new VideoGenerationError("Official Seedance providers require image references", 400);
  return {
    type: "image_url" as const,
    image_url: { url: `data:${mediaType};base64,${data.toString("base64")}` },
    role,
  };
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const error = record(value);
  return string(error.message) ?? string(error.code);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function httpUrl(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && /^https?:\/\//.test(candidate) ? candidate : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Video generation cancelled"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
