import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  TOOL_IDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type PromptImage,
  type VideoAspectRatio,
  type VideoGenerationReference,
  type VideoResolution,
  type ImageSize,
  type RunImageToolRequest,
  type Run3DToolRequest,
  type RunAnimate3DToolRequest,
  type RunVideoToolRequest,
  type RunToolRequest,
  type ToolId,
  type ToolJob,
  type ToolJobContext,
  type ToolRun,
  type ToolRunFile,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator } from "./openai-image.js";
import { Model3DGenerationError, type Generated3DModel, type Model3DAnimationAction, type Model3DGenerator } from "./model3d.js";
import { MAX_ANIMATION_ACTIONS, resolveModel3D } from "../shared/generation-config.js";
import { VideoGenerationError, type VideoGenerator, type VideoReferenceAsset } from "./video-generation.js";
import type { AssetLibrary } from "./asset-library.js";

const VIDEO_DEFAULT_DURATION = 6;
const HISTORY_LIMIT = 20;

interface ToolJobRecord extends ToolJob {
  input?: RunToolRequest;
  metadata: ToolJobMetadata;
  controller: AbortController;
}

interface StoredToolRun extends ToolRun {
  version: 1;
  preview?: { fileName: string; mediaType: "image/png" | "image/jpeg" };
}

interface ToolJobMetadata {
  title?: string;
  context?: ToolJobContext;
}

export class ToolRunError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class ToolRunner {
  readonly #runsDirectory: string;
  readonly #jobs = new Map<string, ToolJobRecord>();
  #animationActions: Promise<Model3DAnimationAction[]> | undefined;

  constructor(
    dataDirectory: string,
    private readonly imageGenerator: ImageGenerator,
    private readonly model3DGenerator?: Model3DGenerator,
    private readonly videoGenerator?: VideoGenerator,
    private readonly assetLibrary?: AssetLibrary,
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
  }

  start(toolId: string, input: RunToolRequest, metadata: ToolJobMetadata = {}): ToolJob {
    if (!isToolId(toolId)) throw new ToolRunError("Tool not found", 404);
    const id = randomUUID();
    const controller = new AbortController();
    const job: ToolJobRecord = {
      id,
      toolId,
      createdAt: new Date().toISOString(),
      status: "running",
      title: promptTitle("prompt" in input ? input.prompt : undefined) ?? metadata.title ?? toolName(toolId),
      ...(metadata.context ? { context: metadata.context } : {}),
      input,
      metadata,
      controller,
    };
    this.#jobs.set(id, job);
    void this.#execute(job);
    return publicJob(job);
  }

  jobs(): ToolJob[] {
    return [...this.#jobs.values()]
      .reverse()
      .map(publicJob);
  }

  cancelJob(jobId: string): ToolJob {
    const job = this.#jobs.get(jobId);
    if (!job) throw new ToolRunError("Generation job not found", 404);
    if (job.status === "running") {
      job.status = "cancelled";
      job.error = "Generation cancelled";
      job.controller.abort();
    }
    return publicJob(job);
  }

  retryJob(jobId: string): ToolJob {
    const job = this.#jobs.get(jobId);
    if (!job) throw new ToolRunError("Generation job not found", 404);
    if (job.status !== "failed" && job.status !== "cancelled") throw new ToolRunError("Only failed or cancelled jobs can be retried", 409);
    if (!job.input) throw new ToolRunError("Generation job can no longer be retried", 409);
    this.#jobs.delete(jobId);
    return this.start(job.toolId, job.input, job.metadata);
  }

  close(): void {
    for (const job of this.#jobs.values()) {
      if (job.status === "running") job.controller.abort();
    }
  }

  async #execute(job: ToolJobRecord): Promise<void> {
    try {
      job.run = await this.run(job.toolId, job.input!, job.controller.signal);
      if (job.run.files.length && job.run.files.every((file) => file.assetId)) {
        await this.removeRun(job.run.id);
      }
      job.status = "succeeded";
      job.input = undefined;
    } catch (cause) {
      if (job.controller.signal.aborted || cause instanceof Error && cause.name === "AbortError") {
        job.status = "cancelled";
        job.error = "Generation cancelled";
      } else {
        job.status = "failed";
        job.error = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      this.#pruneJobs();
    }
  }

  #pruneJobs(): void {
    const terminal = [...this.#jobs.values()]
      .filter((job) => job.status !== "running")
      .reverse();
    for (const job of terminal.slice(HISTORY_LIMIT)) this.#jobs.delete(job.id);
  }

  /** The provider's preset animations. The list rarely changes, so a successful load is kept; failures are retried. */
  async animationActions(): Promise<Model3DAnimationAction[]> {
    const generator = this.model3DGenerator;
    if (!generator?.animations) throw new ToolRunError("3D animation is not configured", 503);
    this.#animationActions ??= generator.animations().catch((cause: unknown) => {
      this.#animationActions = undefined;
      throw cause instanceof Model3DGenerationError ? new ToolRunError(cause.message, cause.statusCode) : cause;
    });
    return this.#animationActions;
  }

  async run(toolId: string, input: RunToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    if (toolId === "image-to-3d") {
      assertOnlyKeys(input, ["images", "model", "targetPolycount", "texture", "pbr"]);
      return this.#run3D(input as Run3DToolRequest, signal);
    }
    if (toolId === "animate-3d") {
      assertOnlyKeys(input, ["assetId", "actionIds", "heightMeters"]);
      return this.#runAnimate3D(input as RunAnimate3DToolRequest, signal);
    }
    if (toolId === "generate-video") {
      assertOnlyKeys(input, ["prompt", "model", "references", "duration", "aspectRatio", "resolution", "referenceMode"]);
      return this.#runVideo(input as RunVideoToolRequest, signal);
    }
    if (toolId !== "generate-image") throw new ToolRunError("Tool not found", 404);
    assertOnlyKeys(input, ["prompt", "imageModel", "size", "resolution", "aspectRatio", "outputs", "images"]);
    return this.#runImage(input as RunImageToolRequest, signal);
  }

  async #runImage(input: RunImageToolRequest, signal: AbortSignal | undefined): Promise<ToolRun> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const imageInput = "images" in input ? input.images : undefined;
    const usesConfiguredOptions = input.resolution !== undefined || input.aspectRatio !== undefined || input.outputs !== undefined || imageInput !== undefined;
    if (input.size !== undefined && usesConfiguredOptions) throw new ToolRunError("Image size cannot be combined with resolution, aspect ratio, output count, or reference images", 400);
    if (usesConfiguredOptions && (input.resolution === undefined || input.aspectRatio === undefined)) {
      throw new ToolRunError("Resolution and aspect ratio are required for configured image generation", 400);
    }
    const size = input.size ?? "1024x1024";
    if (!isImageSize(size)) throw new ToolRunError("Unsupported image size", 400);
    const resolution = input.resolution;
    const aspectRatio = input.aspectRatio;
    const outputs = input.outputs ?? 1;
    if (resolution !== undefined && !isImageResolution(resolution)) throw new ToolRunError("Unsupported image resolution", 400);
    if (aspectRatio !== undefined && !isImageAspectRatio(aspectRatio)) throw new ToolRunError("Unsupported image aspect ratio", 400);
    if (!isImageOutputCount(outputs)) throw new ToolRunError("Unsupported image output count", 400);
    if (imageInput && (imageInput.length > 14 || imageInput.some((image) => !isPromptImage(image, true)))) throw new ToolRunError("Up to 14 PNG, JPEG, or WebP images are supported", 400);

    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    const registeredAssetIds: string[] = [];
    try {
      signal?.throwIfAborted();
      const generated = await Promise.all(Array.from({ length: outputs }, () => this.imageGenerator.generate({
        prompt,
        ...(input.imageModel ? { imageModel: input.imageModel } : {}),
        ...(usesConfiguredOptions ? { resolution: resolution!, aspectRatio: aspectRatio!, ...(imageInput?.length ? { images: imageInput } : {}) } : { size }),
      }, signal)));
      signal?.throwIfAborted();
      const files: ToolRunFile[] = generated.map((image, index) => ({
        name: imageFileName(image.mediaType, outputs > 1 ? index + 1 : undefined),
        mediaType: image.mediaType,
      }));
      if (this.assetLibrary) {
        for (const [index, file] of files.entries()) {
          file.assetId = (await this.assetLibrary!.add(file.name, generated[index]!.bytes, {
            origin: "generated",
            prompt,
            sourceKey: `tool:${id}:${file.name}`,
          })).id;
          registeredAssetIds.push(file.assetId);
        }
      }
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: "generate-image",
        createdAt: new Date().toISOString(),
        files,
      };
      await mkdir(temporary, { recursive: true });
      await Promise.all(generated.map((image, index) => writeFile(path.join(temporary, files[index]!.name), image.bytes)));
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (this.assetLibrary) await Promise.allSettled(registeredAssetIds.map((assetId) => this.assetLibrary!.delete(assetId)));
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof ImageGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #run3D(input: Run3DToolRequest, signal: AbortSignal | undefined): Promise<ToolRun> {
    const { images } = input;
    const model = this.model3DGenerator?.resolveModel ? await this.model3DGenerator.resolveModel(input.model) : resolveModel3D(input.model);
    if (!model) throw new ToolRunError("Unknown 3D model", 400);
    if (!Array.isArray(images) || images.length < 1 || images.length > model.maxReferenceImages) {
      throw new ToolRunError(model.maxReferenceImages === 1 ? "Provide exactly one reference image" : `Provide 1 to ${model.maxReferenceImages} reference images`, 400);
    }
    if (images.some((image) => !isPromptImage(image))) throw new ToolRunError("A PNG or JPEG reference image is required", 400);
    const { polycount } = model;
    if (input.targetPolycount !== undefined && (!Number.isInteger(input.targetPolycount) || input.targetPolycount < polycount.min || input.targetPolycount > polycount.max)) {
      throw new ToolRunError(`3D poly count must be between ${polycount.min} and ${polycount.max}`, 400);
    }
    if (input.texture !== undefined && typeof input.texture !== "boolean") throw new ToolRunError("Texture must be a boolean", 400);
    if (input.pbr !== undefined && typeof input.pbr !== "boolean") throw new ToolRunError("PBR must be a boolean", 400);
    if (!this.model3DGenerator) throw new ToolRunError("3D generation is not configured", 503);
    const generator = this.model3DGenerator;
    const primaryImage = images[0]!;
    return this.#storeModelRun("image-to-3d", signal, () => generator.generate({
      model: { provider: model.provider, id: model.id },
      images,
      targetPolycount: input.targetPolycount,
      texture: input.texture,
      pbr: input.pbr,
    }, signal), {
      fileName: `preview.${primaryImage.mediaType === "image/png" ? "png" : "jpg"}`,
      mediaType: primaryImage.mediaType as "image/png" | "image/jpeg",
      bytes: Buffer.from(primaryImage.data, "base64"),
    });
  }

  async #runAnimate3D(input: RunAnimate3DToolRequest, signal: AbortSignal | undefined): Promise<ToolRun> {
    const { actionIds, heightMeters } = input;
    if (typeof input.assetId !== "string" || !input.assetId) throw new ToolRunError("Choose a 3D model to animate", 400);
    if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > MAX_ANIMATION_ACTIONS
      || actionIds.some((id) => !Number.isInteger(id) || id < 0) || new Set(actionIds).size !== actionIds.length) {
      throw new ToolRunError(`Choose 1 to ${MAX_ANIMATION_ACTIONS} different animations`, 400);
    }
    if (heightMeters !== undefined && (typeof heightMeters !== "number" || !Number.isFinite(heightMeters) || heightMeters <= 0 || heightMeters > 100)) {
      throw new ToolRunError("Character height must be a positive number of meters", 400);
    }
    const generator = this.model3DGenerator;
    if (!generator?.animate) throw new ToolRunError("3D animation is not configured", 503);
    if (!this.assetLibrary) throw new ToolRunError("The asset library is unavailable", 503);
    const source = await this.assetLibrary.content(input.assetId).catch(() => undefined);
    if (!source) throw new ToolRunError("The 3D model is no longer in the Library", 404);
    if (source.asset.contentType !== "model/gltf-binary") throw new ToolRunError("Only GLB models can be animated", 400);
    const model = await readFile(source.absolutePath);
    return this.#storeModelRun("animate-3d", signal, () => generator.animate!({ model, actionIds, ...(heightMeters !== undefined ? { heightMeters } : {}) }, signal));
  }

  /** Saves a generated GLB as a run and a Library asset, undoing both if anything fails part way. */
  async #storeModelRun(
    toolId: "image-to-3d" | "animate-3d",
    signal: AbortSignal | undefined,
    produce: () => Promise<Generated3DModel>,
    preview?: { fileName: string; mediaType: "image/png" | "image/jpeg"; bytes: Buffer },
  ): Promise<ToolRun> {
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    try {
      signal?.throwIfAborted();
      const generated = await produce();
      signal?.throwIfAborted();
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add("model.glb", generated.bytes, {
          origin: "generated",
          sourceKey: `tool:${id}:model.glb`,
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId,
        createdAt: new Date().toISOString(),
        files: [{
          name: "model.glb",
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }],
        ...(preview ? { preview: { fileName: preview.fileName, mediaType: preview.mediaType } } : {}),
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "model.glb"), generated.bytes);
      if (preview) await writeFile(path.join(temporary, preview.fileName), preview.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (this.assetLibrary && registeredAssetId) await this.assetLibrary.delete(registeredAssetId).catch(() => undefined);
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof Model3DGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #runVideo(input: RunVideoToolRequest, signal: AbortSignal | undefined): Promise<ToolRun> {
    if (!this.videoGenerator) throw new ToolRunError("Video generation is not configured", 503);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const references = input.references ?? [];
    validateVideoReferences(references);
    if (input.referenceMode !== undefined && input.referenceMode !== "frame" && input.referenceMode !== "reference") throw new ToolRunError("Unsupported video reference mode", 400);
    const duration = input.duration ?? VIDEO_DEFAULT_DURATION;
    if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new ToolRunError("Unsupported video duration", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    try {
      signal?.throwIfAborted();
      const model = input.model;
      const aspectRatio = input.aspectRatio ?? "adaptive";
      const resolution = input.resolution ?? "720p";
      if (!model || !model.provider.trim() || !model.id.trim() || model.provider.length > 100 || model.id.length > 200) throw new ToolRunError("A valid video model is required", 400);
      if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio as VideoAspectRatio)) throw new ToolRunError("Unsupported video aspect ratio", 400);
      if (!VIDEO_RESOLUTIONS.includes(resolution as VideoResolution)) throw new ToolRunError("Unsupported video resolution", 400);
      const resolvedReferences = await this.#videoReferences(references);
      const generated = await this.videoGenerator.generate({ prompt, model, references: resolvedReferences, duration, aspectRatio, resolution, ...(input.referenceMode ? { referenceMode: input.referenceMode } : {}) }, signal);
      signal?.throwIfAborted();
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add("output.mp4", generated.bytes, {
          origin: "generated",
          prompt,
          sourceKey: `tool:${id}:output.mp4`,
          duration,
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: "generate-video",
        createdAt: new Date().toISOString(),
        files: [{
          name: "output.mp4",
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }],
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "output.mp4"), generated.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (this.assetLibrary && registeredAssetId) await this.assetLibrary.delete(registeredAssetId).catch(() => undefined);
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof VideoGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #videoReferences(references: VideoGenerationReference[]): Promise<VideoReferenceAsset[]> {
    if (!references.length) return [];
    if (!this.assetLibrary) throw new ToolRunError("Asset Library is not configured", 503);
    try {
      return await Promise.all(references.map(async (reference) => {
        const { asset, absolutePath } = await this.assetLibrary!.content(reference.assetId);
        if (asset.mediaType !== reference.type) throw new ToolRunError(`Reference ${asset.name} is not a ${reference.type} asset`, 400);
        if (!supportedVideoReferenceType(reference.type, asset.contentType)) {
          throw new ToolRunError(`Unsupported ${reference.type} reference format: ${asset.contentType}`, 400);
        }
        const maximum = reference.type === "image" ? 30 * 1024 * 1024
          : reference.type === "video" ? 200 * 1024 * 1024
            : 15 * 1024 * 1024;
        if (asset.size > maximum) throw new ToolRunError(`${reference.type} reference is too large`, 400);
        return { type: reference.type, name: asset.name, mediaType: asset.contentType, absolutePath, ...(asset.duration !== undefined ? { duration: asset.duration } : {}) };
      }));
    } catch (cause) {
      if (cause instanceof ToolRunError) throw cause;
      throw new ToolRunError(cause instanceof Error ? cause.message : String(cause), 400);
    }
  }

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string; assetId?: string; preview?: { bytes: Buffer; mediaType: "image/png" | "image/jpeg" } } | undefined> {
    if (!isRunId(runId) || !isToolRunFileName(fileName)) return undefined;
    try {
      const directory = path.join(this.#runsDirectory, runId);
      const run = await this.#readRun(runId);
      if (!run) return undefined;
      const file = run.files.find((candidate) => candidate.name === fileName);
      const filePath = path.join(directory, fileName);
      if (!file || !(await stat(filePath)).isFile()) return undefined;
      const preview = run.preview
        ? { bytes: await readFile(path.join(directory, run.preview.fileName)), mediaType: run.preview.mediaType }
        : undefined;
      return {
        bytes: await readFile(filePath),
        mediaType: file.mediaType,
        ...(file.assetId ? { assetId: file.assetId } : {}),
        ...(preview ? { preview } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async removeRun(runId: string): Promise<void> {
    if (!isRunId(runId)) return;
    await rm(path.join(this.#runsDirectory, runId), { recursive: true, force: true });
  }

  async #readRun(runId: string): Promise<StoredToolRun | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.#runsDirectory, runId, "run.json"), "utf8")) as Partial<StoredToolRun>;
      if (value.version !== 1 || value.id !== runId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !isToolId(value.toolId) || !Array.isArray(value.files)) return undefined;
      if (value.files.some((file) => !file || typeof file.name !== "string" || typeof file.mediaType !== "string" ||
        file.assetId !== undefined && typeof file.assetId !== "string")) return undefined;
      return value as StoredToolRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}

function isPromptImage(value: unknown, allowWebP = false): value is PromptImage {
  if (!value || typeof value !== "object") return false;
  const image = value as { mediaType?: unknown; data?: unknown };
  return (image.mediaType === "image/png" || image.mediaType === "image/jpeg" || (allowWebP && image.mediaType === "image/webp")) && typeof image.data === "string" && image.data.length > 0;
}

function validateVideoReferences(references: VideoGenerationReference[]): void {
  if (!Array.isArray(references) || references.some((reference) => !reference || typeof reference.assetId !== "string" || !reference.assetId || reference.type !== "image")) {
    throw new ToolRunError("Invalid video references", 400);
  }
}

function supportedVideoReferenceType(type: VideoGenerationReference["type"], contentType: string): boolean {
  if (type === "image") return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
  if (type === "video") return contentType === "video/mp4" || contentType === "video/quicktime";
  return contentType === "audio/mpeg" || contentType === "audio/wav";
}

function publicRun({ version: _, preview: __, ...run }: StoredToolRun): ToolRun {
  return { ...run, files: run.files.map((file) => ({ ...file })) };
}

function publicJob({ input: _, metadata: __, controller: ___, ...job }: ToolJobRecord): ToolJob {
  return { ...job, ...(job.run ? { run: { ...job.run, files: job.run.files.map((file) => ({ ...file })) } } : {}) };
}

function toolName(toolId: ToolId): string {
  if (toolId === "generate-video") return "Generated Video";
  if (toolId === "image-to-3d") return "Generated 3D Model";
  if (toolId === "animate-3d") return "Animated 3D Model";
  return "Generated Image";
}

function promptTitle(value?: string): string | undefined {
  const prompt = value?.replace(/\s+/g, " ").trim();
  if (!prompt) return undefined;
  return prompt.length > 60 ? `${prompt.slice(0, 57).trimEnd()}...` : prompt;
}

function assertOnlyKeys(input: RunToolRequest, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new ToolRunError(`Unexpected ${unexpected} option`, 400);
}

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize);
}

function isImageResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && IMAGE_RESOLUTIONS.includes(value as ImageResolution);
}

function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio);
}

function isImageOutputCount(value: unknown): value is ImageOutputCount {
  return typeof value === "number" && IMAGE_OUTPUT_COUNTS.includes(value as ImageOutputCount);
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isToolRunFileName(value: string): boolean {
  return /^(?:output(?:-[1-4])?\.(?:png|jpg|webp)|model\.glb|output\.mp4)$/.test(value);
}

function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && TOOL_IDS.includes(value as ToolId);
}

function imageFileName(mediaType: string, index?: number): string {
  const suffix = index ? `-${index}` : "";
  return mediaType === "image/png" ? `output${suffix}.png` : mediaType === "image/jpeg" ? `output${suffix}.jpg` : `output${suffix}.webp`;
}
