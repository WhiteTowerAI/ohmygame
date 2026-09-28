import { readFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { VideoModel, VideoModelRef } from "../shared/contracts.js";
import {
  VideoGenerationError,
  type GeneratedVideo,
  type VideoGenerationInput,
  type VideoGenerator,
  type VideoReferenceAsset,
} from "./video-generation.js";
import {
  listOpenRouterVideoModels,
  openRouterHeaders,
  resolveOpenRouterMediaSource,
  type OpenRouterMediaSource,
} from "./openrouter-media.js";

const MAX_WAIT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 5_000;

export class ProviderVideos implements VideoGenerator {
  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async models(signal?: AbortSignal): Promise<VideoModel[]> {
    try {
      const runtime = await this.runtime();
      const source = await resolveOpenRouterMediaSource(runtime, signal);
      const openRouter = source ? await listOpenRouterVideoModels(source, this.request, signal).catch(() => []) : [];
      return openRouter;
    } catch {
      return [];
    }
  }

  async generate(input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo> {
    const runtime = await this.runtime();
    const source = await resolveOpenRouterMediaSource(runtime, signal);
    if (source) {
      const models = await listOpenRouterVideoModels(source, this.request, signal);
      const model = models.find((candidate) => sameModel(candidate, input.model));
      if (model) return this.#generateOpenRouter(source, model, input, signal);
    }
    throw new VideoGenerationError("The selected video model is not available", 503);
  }

  async #generateOpenRouter(source: OpenRouterMediaSource, model: VideoModel, input: VideoGenerationInput, signal?: AbortSignal): Promise<GeneratedVideo> {
    const duration = input.duration ?? model.durations[0]!;
    const resolution = input.resolution ?? model.resolutions[0]!;
    const aspectRatio = input.aspectRatio ?? model.aspectRatios[0]!;
    if (!model.durations.includes(duration)) throw new VideoGenerationError("Video duration is not supported by the selected model", 400);
    if (!model.resolutions.includes(resolution)) throw new VideoGenerationError("Video resolution is not supported by the selected model", 400);
    if (!model.aspectRatios.includes(aspectRatio)) throw new VideoGenerationError("Video aspect ratio is not supported by the selected model", 400);
    const references = input.references ?? [];
    if (references.some((reference) => reference.type !== "image")) {
      throw new VideoGenerationError("OpenRouter video generation currently supports image references only", 400);
    }
    if (references.length > model.maxImageReferences) {
      throw new VideoGenerationError(`The selected video model supports up to ${model.maxImageReferences} reference images`, 400);
    }
    const referenceItems = await Promise.all(references.map(referenceItem));
    const referencePayload = model.imageReferenceMode === "frame" && referenceItems.length
      ? { frame_images: referenceItems.slice(0, 2).map((reference, index) => ({ ...reference, frame_type: index === 0 ? "first_frame" : "last_frame" })) }
      : referenceItems.length ? { input_references: referenceItems } : {};
    const created = await json(await this.request(`${source.baseUrl}/videos`, {
      method: "POST",
      headers: openRouterHeaders(source, true),
      body: JSON.stringify({
        model: model.id,
        prompt: input.prompt,
        duration,
        resolution,
        aspect_ratio: aspectRatio,
        ...referencePayload,
      }),
      signal,
    }), "OpenRouter video generation request failed");
    const requestId = string(created.id);
    const pollingUrl = httpUrl(created.polling_url) ?? (requestId ? `${source.baseUrl}/videos/${encodeURIComponent(requestId)}` : undefined);
    if (!requestId || !pollingUrl) throw new VideoGenerationError("OpenRouter returned no video job ID");

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const status = await json(await this.request(pollingUrl, { headers: openRouterHeaders(source), signal }), "OpenRouter video status request failed");
      const state = string(status.status)?.toLowerCase();
      if (state === "completed" || state === "succeeded" || state === "success") {
        const contentUrl = firstHttpUrl(status.unsigned_urls) ?? httpUrl(status.content_url) ?? `${source.baseUrl}/videos/${encodeURIComponent(requestId)}/content`;
        const content = await this.request(contentUrl, { headers: openRouterHeaders(source), signal });
        if (!content.ok) throw new VideoGenerationError(`OpenRouter video download failed (${content.status})`, content.status);
        return { bytes: Buffer.from(await content.arrayBuffer()), mediaType: "video/mp4", requestId };
      }
      if (state === "failed" || state === "failure" || state === "error" || state === "expired" || state === "cancelled") {
        throw new VideoGenerationError(errorMessage(status.error) ?? `OpenRouter video generation ${state}`);
      }
      await delay(POLL_INTERVAL_MS, signal);
    }
    throw new VideoGenerationError("OpenRouter video generation timed out", 504);
  }
}

function sameModel(left: VideoModelRef | undefined, right: VideoModelRef | undefined): boolean {
  return Boolean(left && right && left.provider === right.provider && left.id === right.id);
}

async function referenceItem(reference: VideoReferenceAsset) {
  const data = await readFile(reference.absolutePath);
  return {
    type: "image_url" as const,
    image_url: { url: `data:${reference.mediaType};base64,${data.toString("base64")}` },
  };
}

async function json(response: Response, message: string): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) return body;
  const detail = errorMessage(body.error);
  if (response.status === 401 || response.status === 403) throw new VideoGenerationError("OpenRouter credentials were rejected", 503);
  if (response.status === 429) throw new VideoGenerationError("OpenRouter video generation is temporarily rate limited", 429);
  throw new VideoGenerationError(detail ?? message, response.status >= 500 ? 502 : 400);
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && "message" in value) return string((value as { message?: unknown }).message);
  return undefined;
}

function firstHttpUrl(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(httpUrl).find(Boolean) : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && /^https?:\/\//.test(candidate) ? candidate : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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
