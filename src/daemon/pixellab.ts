import { PIXELLAB_SKELETON_LABELS, type ImageModel, type SkeletonKeypoint } from "../shared/contracts.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput, type ImageGenerator } from "./openai-image.js";
import sharp from "sharp";

const ENDPOINT = "https://api.pixellab.ai/v2/create-image-pixen";
const SKELETON_LABEL_SET = new Set<string>(PIXELLAB_SKELETON_LABELS);

/** PixelLab's fast, native-resolution text-to-pixel-art model. */
export const PIXELLAB_PIXEN_MODEL: ImageModel = {
  provider: "pixellab",
  providerName: "PixelLab",
  id: "pixen",
  name: "Pixen Pixel Art",
  sizes: [],
  // The generic canvas node keeps a 1K setting internally. Pixen has its own
  // native pixel canvas, so its controls deliberately stay hidden.
  generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }],
  supportsReferenceImage: false,
  maxOutputs: 1,
  protocol: "openai-images",
  supportsResolution: false,
  supportsAspectRatio: false,
};

export const PIXELLAB_ANIMATION_MODEL: ImageModel = {
  ...PIXELLAB_PIXEN_MODEL,
  id: "animate-v3",
  name: "Pixel Animation",
  supportsReferenceImage: true,
  maxReferenceImages: 1,
};

/** Produces the eight cardinal/intercardinal views needed by directional games. */
export const PIXELLAB_EIGHT_DIRECTIONS_MODEL: ImageModel = {
  ...PIXELLAB_PIXEN_MODEL,
  id: "8-rotations-v3",
  name: "8 Directions",
  supportsReferenceImage: true,
  maxReferenceImages: 1,
};

/** Finds character joints and returns a visual pose guide. */
export const PIXELLAB_SKELETON_MODEL: ImageModel = {
  ...PIXELLAB_PIXEN_MODEL,
  id: "estimate-skeleton",
  name: "Skeleton Recognition",
  supportsReferenceImage: true,
  maxReferenceImages: 1,
};

/** Uses a saved Skeleton Recognition rig to make a deterministic 2D action clip. */
export const PIXELLAB_SKELETON_ANIMATION_MODEL: ImageModel = {
  ...PIXELLAB_ANIMATION_MODEL,
  id: "animate-skeleton-v3",
  name: "Skeleton Animation (Beta)",
};

/** Keeps PixelLab's token and HTTP details out of the renderer. */
export class PixelLab implements ImageGenerator {
  constructor(private readonly apiKey: () => string | undefined, private readonly request: typeof fetch = fetch) {}

  configured(): boolean { return Boolean(this.apiKey()); }
  models(): ImageModel[] {
    return this.configured()
      ? [PIXELLAB_PIXEN_MODEL, PIXELLAB_ANIMATION_MODEL, PIXELLAB_EIGHT_DIRECTIONS_MODEL, PIXELLAB_SKELETON_MODEL, PIXELLAB_SKELETON_ANIMATION_MODEL]
      : [];
  }

  async generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const key = this.apiKey();
    if (!key) throw new ImageGenerationError("PixelLab API key is not configured", 503);
    if (input.imageModel?.id === "animate-v3") return this.animate(input, key, signal);
    if (input.imageModel?.id === "animate-skeleton-v3") return this.animateSkeleton(input, key, signal);
    if (input.imageModel?.id === "8-rotations-v3") return this.eightDirections(input, key, signal);
    if (input.imageModel?.id === "estimate-skeleton") return this.estimateSkeleton(input, key, signal);
    if (input.images?.length) throw new ImageGenerationError("Pixen does not support reference images", 400);
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(90_000);
      response = await this.request(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ description: input.prompt, image_size: { width: 128, height: 128 }, no_background: input.transparentBackground === true }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      throw new ImageGenerationError(`Could not reach PixelLab (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    const body = await response.json().catch(() => ({})) as { detail?: unknown; message?: unknown; image?: { base64?: unknown } };
    if (!response.ok) throw pixelLabError(response.status, body);
    const encoded = body.image?.base64;
    if (typeof encoded !== "string") throw new ImageGenerationError("PixelLab returned no generated image");
    const value = encoded.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    const bytes = Buffer.from(value, "base64");
    if (!bytes.length) throw new ImageGenerationError("PixelLab returned an invalid image");
    return { bytes, mediaType: "image/png" };
  }

  private async animate(input: ImageGenerationInput, key: string, signal?: AbortSignal): Promise<GeneratedImage> {
    const first = input.images?.[0];
    if (!first) throw new ImageGenerationError("Pixel Animation needs one first-frame image", 400);
    const response = await this.json("https://api.pixellab.ai/v2/animate-with-text-v3", key, {
      first_frame: { base64: `data:${first.mediaType};base64,${first.data}` }, action: input.prompt, frame_count: 8, no_background: input.transparentBackground === true,
    }, signal);
    const jobId = typeof response.background_job_id === "string" ? response.background_job_id : undefined;
    if (!jobId) throw new ImageGenerationError("PixelLab did not return an animation job");
    const frames = await this.jobImages(jobId, key, signal, "animation");
    const [firstFrame, ...rest] = frames;
    if (!firstFrame) throw new ImageGenerationError("PixelLab returned no animation frames");
    return { bytes: firstFrame, mediaType: "image/png", additionalImages: rest.map((bytes) => ({ bytes, mediaType: "image/png" as const })) };
  }

  private async eightDirections(input: ImageGenerationInput, key: string, signal?: AbortSignal): Promise<GeneratedImage> {
    const first = input.images?.[0];
    if (!first) throw new ImageGenerationError("8 Directions needs one source image", 400);
    const source = await normalizedSource(first, 256);
    const response = await this.json("https://api.pixellab.ai/v2/generate-8-rotations-v3", key, {
      first_frame: { base64: `data:image/png;base64,${source.bytes.toString("base64")}` },
      ...(input.prompt.trim() ? { description: input.prompt } : {}),
      no_background: input.transparentBackground === true,
    }, signal);
    const jobId = typeof response.background_job_id === "string" ? response.background_job_id : undefined;
    if (!jobId) throw new ImageGenerationError("PixelLab did not return an 8 Directions job");
    const frames = await this.jobImages(jobId, key, signal, "8 Directions");
    return { bytes: await spriteSheet(frames), mediaType: "image/png" };
  }

  private async estimateSkeleton(input: ImageGenerationInput, key: string, signal?: AbortSignal): Promise<GeneratedImage> {
    const first = input.images?.[0];
    if (!first) throw new ImageGenerationError("Skeleton Recognition needs one character image", 400);
    const source = await normalizedSource(first, 256);
    const response = await this.json("https://api.pixellab.ai/v2/estimate-skeleton", key, {
      image: { base64: `data:image/png;base64,${source.bytes.toString("base64")}` },
    }, signal);
    const keypoints = Array.isArray(response.keypoints) ? response.keypoints.flatMap(keypoint) : [];
    if (!completeSkeleton(keypoints)) throw new ImageGenerationError("PixelLab could not identify a complete 18-joint character skeleton. Use a clear, full-body character image.", 422);
    // Keep the actual sprite clean: the rig is persisted beside it as structured
    // data, so this output can feed the next animation node directly.
    return { bytes: source.bytes, mediaType: "image/png", skeleton: { keypoints } };
  }

  private async animateSkeleton(input: ImageGenerationInput, key: string, signal?: AbortSignal): Promise<GeneratedImage> {
    const first = input.images?.[0], skeleton = input.skeleton;
    if (!first) throw new ImageGenerationError("Skeleton Animation needs one character image", 400);
    if (!completeSkeleton(skeleton?.keypoints)) throw new ImageGenerationError("Skeleton Animation needs a complete Skeleton Recognition result from this character", 400);
    const source = await normalizedSource(first, 256);
    const response = await this.json("https://api.pixellab.ai/v2/animate-with-skeleton-v3", key, {
      description: input.characterDescription?.trim() || "pixel art game character",
      action: input.prompt.trim() || "idle",
      direction: "south",
      first_frame: { base64: `data:image/png;base64,${source.bytes.toString("base64")}` },
      first_frame_keypoints: skeleton.keypoints.map(toPixelLabKeypoint),
      keypoints: actionFrames(skeleton.keypoints, input.prompt),
      template_id: "mannequin",
      no_background: input.transparentBackground !== false,
    }, signal);
    const jobId = typeof response.background_job_id === "string" ? response.background_job_id : undefined;
    if (!jobId) throw new ImageGenerationError("PixelLab did not return a skeleton animation job");
    const frames = await this.jobImages(jobId, key, signal, "skeleton animation");
    const [firstFrame, ...rest] = frames;
    if (!firstFrame) throw new ImageGenerationError("PixelLab returned no skeleton animation frames");
    return { bytes: firstFrame, mediaType: "image/png", additionalImages: rest.map((bytes) => ({ bytes, mediaType: "image/png" as const })) };
  }

  private async jobImages(jobId: string, key: string, signal: AbortSignal | undefined, kind: string): Promise<Buffer[]> {
    const started = Date.now();
    while (Date.now() - started < 190_000) {
      await wait(5_000, signal);
      const job = await this.getJson(`https://api.pixellab.ai/v2/background-jobs/${encodeURIComponent(jobId)}`, key, signal) as { status?: unknown; last_response?: { detail?: unknown; images?: unknown[] } };
      if (job.status === "failed" || job.status === "cancelled") throw new ImageGenerationError(`PixelLab ${kind} failed: ${typeof job.last_response?.detail === "string" ? job.last_response.detail : "unknown error"}`, 502);
      if (job.status !== "completed") continue;
      const frames = Array.isArray(job.last_response?.images) ? job.last_response.images.map(imageBytes).filter((item): item is Buffer => Boolean(item)) : [];
      if (!frames.length) throw new ImageGenerationError(`PixelLab returned no ${kind} frames`);
      return frames;
    }
    throw new ImageGenerationError(`PixelLab ${kind} timed out`, 504);
  }

  private async json(url: string, key: string, body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(90_000);
    let response: Response;
    try { response = await this.request(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch (cause) { if (signal?.aborted) throw signal.reason ?? cause; throw new ImageGenerationError("Could not reach PixelLab"); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw pixelLabError(response.status, value);
    return value;
  }

  private async getJson(url: string, key: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.request(url, { headers: { authorization: `Bearer ${key}` }, signal }); }
    catch (cause) { if (signal?.aborted) throw signal.reason ?? cause; throw new ImageGenerationError("Could not reach PixelLab"); }
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw pixelLabError(response.status, value);
    return value;
  }
}

function imageBytes(value: unknown): Buffer | undefined {
  const base64 = typeof value === "object" && value && "base64" in value && typeof value.base64 === "string" ? value.base64 : undefined;
  if (!base64) return undefined;
  const bytes = Buffer.from(base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ""), "base64");
  return bytes.length ? bytes : undefined;
}

async function normalizedSource(image: { data: string; mediaType: string }, maximum = 2048): Promise<{ bytes: Buffer; size: { width: number; height: number } }> {
  const source = Buffer.from(image.data, "base64");
  const metadata = await sharp(source).metadata().catch(() => undefined);
  if (!metadata?.width || !metadata.height) throw new ImageGenerationError("The reference image is invalid", 400);
  const scale = Math.min(1, maximum / Math.max(metadata.width, metadata.height));
  const width = Math.max(16, Math.round(metadata.width * scale));
  const height = Math.max(16, Math.round(metadata.height * scale));
  const bytes = await sharp(source).resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest }).png().toBuffer();
  return { bytes, size: { width, height } };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); done(signal?.reason); };
    function done(reason?: unknown) {
      signal?.removeEventListener("abort", abort);
      if (reason) reject(reason);
      else resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function keypoint(value: unknown): SkeletonKeypoint[] {
  if (!value || typeof value !== "object") return [];
  const point = value as { x?: unknown; y?: unknown; label?: unknown; z_index?: unknown };
  return typeof point.x === "number" && point.x >= 0 && point.x <= 1 && typeof point.y === "number" && point.y >= 0 && point.y <= 1 && typeof point.label === "string" && SKELETON_LABEL_SET.has(point.label)
    ? [{ x: point.x, y: point.y, label: point.label, ...(typeof point.z_index === "number" && Number.isInteger(point.z_index) ? { zIndex: point.z_index } : {}) }]
    : [];
}

function completeSkeleton(keypoints: SkeletonKeypoint[] | undefined): keypoints is SkeletonKeypoint[] {
  return Boolean(keypoints && keypoints.length === PIXELLAB_SKELETON_LABELS.length && new Set(keypoints.map((point) => point.label)).size === PIXELLAB_SKELETON_LABELS.length && keypoints.every((point) => SKELETON_LABEL_SET.has(point.label) && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1));
}

function toPixelLabKeypoint(point: SkeletonKeypoint) { return { x: point.x, y: point.y, label: point.label, ...(point.zIndex !== undefined ? { z_index: point.zIndex } : {}) }; }

/** Small reliable action templates; a later editor can replace these target poses per joint. */
function actionFrames(base: SkeletonKeypoint[], action: string): Array<ReturnType<typeof toPixelLabKeypoint>[]> {
  const normalized = action.toLowerCase();
  const movement = normalized.includes("run") ? 0.12 : normalized.includes("walk") ? 0.07 : normalized.includes("fall") || normalized.includes("倒") ? 0.35 : normalized.includes("attack") || normalized.includes("攻击") ? 0.14 : 0.025;
  return [-1, 0, 1, 0].map((phase) => base.map((point) => {
    let x = point.x, y = point.y;
    const arm = point.label.includes("ARM") || point.label.includes("ELBOW") || point.label.includes("SHOULDER");
    const leg = point.label.includes("LEG") || point.label.includes("KNEE") || point.label.includes("HIP");
    if (normalized.includes("fall") || normalized.includes("倒")) { const pivotX = 0.5, pivotY = 0.72, angle = (phase + 1) * Math.PI / 8; const dx = x - pivotX, dy = y - pivotY; x = pivotX + dx * Math.cos(angle) - dy * Math.sin(angle); y = pivotY + dx * Math.sin(angle) + dy * Math.cos(angle); }
    else if (arm || leg) { const sign = point.label.startsWith("LEFT") ? -1 : 1; x += sign * phase * movement * (arm ? 1 : -1); y += Math.abs(phase) * movement * (leg ? 0.35 : 0.15); }
    return toPixelLabKeypoint({ ...point, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  }));
}

async function spriteSheet(frames: Buffer[]): Promise<Buffer> {
  const metadata = await sharp(frames[0]!).metadata();
  if (!metadata.width || !metadata.height) throw new ImageGenerationError("PixelLab returned an invalid animation frame");
  const columns = Math.min(4, frames.length), rows = Math.ceil(frames.length / columns);
  return sharp({ create: { width: metadata.width * columns, height: metadata.height * rows, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(await Promise.all(frames.map(async (frame, index) => ({ input: await sharp(frame).resize(metadata.width, metadata.height, { fit: "fill" }).png().toBuffer(), left: (index % columns) * metadata.width!, top: Math.floor(index / columns) * metadata.height! }))))
    .png().toBuffer();
}

function pixelLabError(status: number, body: { detail?: unknown; message?: unknown }): ImageGenerationError {
  const detail = typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : "request failed";
  if (status === 401 || status === 403) return new ImageGenerationError("PixelLab API key was rejected", 503);
  if (status === 402) return new ImageGenerationError("PixelLab has insufficient credits", 402);
  if (status === 429) return new ImageGenerationError("PixelLab is temporarily rate limited", 429);
  return new ImageGenerationError(`PixelLab ${status}: ${detail}`, status >= 500 ? 502 : 400);
}
