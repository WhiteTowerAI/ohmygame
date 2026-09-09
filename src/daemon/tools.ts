import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  MODEL_3D_MODELS,
  MODEL_3D_POSES,
  MODEL_3D_QUALITIES,
  MODEL_3D_TEXTURE_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type PromptImage,
  type VideoAspectRatio,
  type VideoResolution,
  type ImageSize,
  type RunImageToolRequest,
  type Run3DToolRequest,
  type RunVideoToolRequest,
  type RunToolRequest,
  type ToolDefinition,
  type ToolRun,
  type ToolRunFile,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator } from "./openai-image.js";
import { Meshy3DGenerator, Model3DGenerationError, type Model3DGenerator } from "./meshy-3d.js";
import { VideoGenerationError, type VideoGenerator } from "./seedance-video.js";
import type { AssetLibrary } from "./asset-library.js";

const generateImage: ToolDefinition = {
  id: "generate-image",
  name: "Image Generator",
  description: "Generate a game-ready image from a text prompt.",
  category: "images",
  inputKind: "prompt",
  outputKind: "image",
  sizes: IMAGE_SIZES,
  defaultSize: "1024x1024",
};

const imageTo3D: ToolDefinition = {
  id: "image-to-3d",
  name: "3D Generator",
  description: "Generate a 3D model from a text prompt or reference image.",
  category: "3d",
  inputKind: "image-prompt",
  outputKind: "model",
};

const VIDEO_DEFAULT_DURATION = 6;
const generateVideo: ToolDefinition = {
  id: "generate-video",
  name: "Video Generator",
  description: "Generate a project-ready video from a text prompt or reference image.",
  category: "video",
  inputKind: "image-prompt",
  outputKind: "video",
  defaultDuration: VIDEO_DEFAULT_DURATION,
  minDuration: 4,
  maxDuration: 15,
  aspectRatios: VIDEO_ASPECT_RATIOS,
  resolutions: VIDEO_RESOLUTIONS,
};

const HISTORY_LIMIT = 20;

interface StoredToolRun extends ToolRun {
  version: 1;
  files: StoredToolRunFile[];
  requestId?: string;
  prompt?: string;
  preview?: { fileName: string; mediaType: "image/png" | "image/jpeg" };
}

interface StoredToolRunFile extends ToolRunFile {
  assetId?: string;
}

interface ToolRunMetadata {
  title?: string;
}

export class ToolRunError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class ToolRunner {
  readonly #runsDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly imageGenerator: ImageGenerator,
    private readonly model3DGenerator: Model3DGenerator = new Meshy3DGenerator(),
    private readonly videoGenerator?: VideoGenerator,
    private readonly assetLibrary?: AssetLibrary,
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
  }

  list(): ToolDefinition[] {
    return [generateImage, imageTo3D, generateVideo];
  }

  async run(toolId: string, input: RunToolRequest, signal?: AbortSignal, metadata: ToolRunMetadata = {}): Promise<ToolRun> {
    if (toolId === imageTo3D.id) {
      assertOnlyKeys(input, ["prompt", "images", "model", "quality", "targetPolycount", "texture", "textureResolution", "pbr", "pose", "imageEnhancement"]);
      return this.#run3D(input as Run3DToolRequest, signal, metadata);
    }
    if (toolId === generateVideo.id) {
      assertOnlyKeys(input, ["prompt", "images", "duration", "aspectRatio", "resolution"]);
      return this.#runVideo(input as RunVideoToolRequest, signal, metadata);
    }
    if (toolId !== generateImage.id) throw new ToolRunError("Tool not found", 404);
    assertOnlyKeys(input, ["prompt", "size", "resolution", "aspectRatio", "outputs", "images"]);
    return this.#runImage(input as RunImageToolRequest, signal, metadata);
  }

  async #runImage(input: RunImageToolRequest, signal: AbortSignal | undefined, metadata: ToolRunMetadata): Promise<ToolRun> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const imageInput = "images" in input ? input.images : undefined;
    const usesStudioOptions = input.resolution !== undefined || input.aspectRatio !== undefined || input.outputs !== undefined || imageInput !== undefined;
    if (input.size !== undefined && usesStudioOptions) throw new ToolRunError("Image size cannot be combined with Asset Studio options", 400);
    if (usesStudioOptions && (input.resolution === undefined || input.aspectRatio === undefined)) {
      throw new ToolRunError("Resolution and aspect ratio are required for Asset Studio images", 400);
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
        ...(usesStudioOptions ? { resolution: resolution!, aspectRatio: aspectRatio!, ...(imageInput?.length ? { images: imageInput } : {}) } : { size }),
      }, signal)));
      signal?.throwIfAborted();
      const files: StoredToolRunFile[] = generated.map((image, index) => ({
        name: imageFileName(image.mediaType, outputs > 1 ? index + 1 : undefined),
        mediaType: image.mediaType,
      }));
      if (this.assetLibrary) {
        for (const [index, file] of files.entries()) {
          file.assetId = (await this.assetLibrary!.add(file.name, generated[index]!.bytes, {
            prompt,
            sourceKey: `tool:${id}:${file.name}`,
          })).id;
          registeredAssetIds.push(file.assetId);
        }
      }
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: generateImage.id,
        createdAt: new Date().toISOString(),
        files,
        prompt,
        ...(metadata.title ? { title: metadata.title } : {}),
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

  async #run3D(input: Run3DToolRequest, signal: AbortSignal | undefined, metadata: ToolRunMetadata): Promise<ToolRun> {
    const prompt = input.prompt?.trim();
    const images = "images" in input ? input.images : undefined;
    const hasImages = images !== undefined;
    if (Boolean(prompt) === hasImages) throw new ToolRunError("Provide either a prompt or reference images", 400);
    if (prompt && prompt.length > 800) throw new ToolRunError("3D prompt must not exceed 800 characters", 400);
    if (images && (images.length < 1 || images.length > 4)) throw new ToolRunError("Provide 1 to 4 reference images", 400);
    if (images?.some((image) => !isPromptImage(image))) throw new ToolRunError("PNG or JPEG reference images are required", 400);
    if (input.model !== undefined && !MODEL_3D_MODELS.includes(input.model)) throw new ToolRunError("Unsupported 3D model", 400);
    if (input.quality !== undefined && !MODEL_3D_QUALITIES.includes(input.quality)) throw new ToolRunError("Unsupported 3D quality", 400);
    if (input.targetPolycount !== undefined && (!Number.isInteger(input.targetPolycount) || input.targetPolycount < 100 || input.targetPolycount > 15_000)) {
      throw new ToolRunError("3D poly count must be between 100 and 15000", 400);
    }
    if (input.textureResolution !== undefined && !MODEL_3D_TEXTURE_RESOLUTIONS.includes(input.textureResolution)) throw new ToolRunError("Unsupported texture resolution", 400);
    if (input.pose !== undefined && !MODEL_3D_POSES.includes(input.pose)) throw new ToolRunError("Unsupported 3D pose", 400);
    if (input.texture !== undefined && typeof input.texture !== "boolean") throw new ToolRunError("Texture must be a boolean", 400);
    if (input.pbr !== undefined && typeof input.pbr !== "boolean") throw new ToolRunError("PBR must be a boolean", 400);
    if (input.imageEnhancement !== undefined && typeof input.imageEnhancement !== "boolean") throw new ToolRunError("Image enhancement must be a boolean", 400);
    if (prompt && input.imageEnhancement !== undefined) throw new ToolRunError("Image enhancement requires reference images", 400);
    const model = input.model ?? "meshy-7";
    if (model === "meshy-t2" && images && images.length !== 1) throw new ToolRunError("Meshy T2 requires exactly one reference image", 400);
    if (model === "meshy-t2" && input.quality !== undefined) throw new ToolRunError("Meshy T2 does not support quality modes", 400);
    if (model === "meshy-t2" && input.imageEnhancement !== undefined) throw new ToolRunError("Meshy T2 does not support image enhancement", 400);
    if (model !== "meshy-t2" && input.targetPolycount !== undefined) throw new ToolRunError("Poly count requires Meshy T2", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    try {
      signal?.throwIfAborted();
      const options = {
        model: input.model,
        quality: input.quality,
        targetPolycount: input.targetPolycount,
        texture: input.texture,
        textureResolution: input.textureResolution,
        pbr: input.pbr,
        pose: input.pose,
      };
      const generated = await this.model3DGenerator.generate(
        prompt
          ? { ...options, prompt }
          : { ...options, images: images!, ...(input.imageEnhancement !== undefined ? { imageEnhancement: input.imageEnhancement } : {}) },
        signal,
      );
      signal?.throwIfAborted();
      const primaryImage = images?.[0];
      const preview = primaryImage ? {
        fileName: `preview.${primaryImage.mediaType === "image/png" ? "png" : "jpg"}`,
        mediaType: primaryImage.mediaType as "image/png" | "image/jpeg",
      } : undefined;
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add("model.glb", generated.bytes, {
          ...(prompt ? { prompt } : {}),
          sourceKey: `tool:${id}:model.glb`,
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: imageTo3D.id,
        createdAt: new Date().toISOString(),
        files: [{
          name: "model.glb",
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }],
        requestId: generated.requestId,
        ...(prompt ? { prompt } : {}),
        ...(preview ? { preview } : {}),
        ...(metadata.title ? { title: metadata.title } : {}),
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "model.glb"), generated.bytes);
      if (preview && primaryImage) await writeFile(path.join(temporary, preview.fileName), Buffer.from(primaryImage.data, "base64"));
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

  async #runVideo(input: RunVideoToolRequest, signal: AbortSignal | undefined, metadata: ToolRunMetadata): Promise<ToolRun> {
    if (!this.videoGenerator) throw new ToolRunError("Video generation is not configured", 503);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const images = input.images;
    if (images && (images.length > 9 || images.some((image) => !isPromptImage(image, true)))) throw new ToolRunError("Up to 9 PNG, JPEG, or WebP reference images are supported", 400);
    const duration = input.duration ?? VIDEO_DEFAULT_DURATION;
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new ToolRunError("Unsupported video duration", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let registeredAssetId: string | undefined;
    try {
      signal?.throwIfAborted();
      const aspectRatio = input.aspectRatio ?? "adaptive";
      const resolution = input.resolution ?? "720p";
      if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio as VideoAspectRatio)) throw new ToolRunError("Unsupported video aspect ratio", 400);
      if (!VIDEO_RESOLUTIONS.includes(resolution as VideoResolution)) throw new ToolRunError("Unsupported video resolution", 400);
      const generated = await this.videoGenerator.generate({ prompt, images, duration, aspectRatio, resolution }, signal);
      signal?.throwIfAborted();
      if (this.assetLibrary) {
        registeredAssetId = (await this.assetLibrary.add("output.mp4", generated.bytes, {
          prompt,
          sourceKey: `tool:${id}:output.mp4`,
        })).id;
      }
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: generateVideo.id,
        createdAt: new Date().toISOString(),
        files: [{
          name: "output.mp4",
          mediaType: generated.mediaType,
          ...(registeredAssetId ? { assetId: registeredAssetId } : {}),
        }],
        requestId: generated.requestId,
        prompt,
        ...(metadata.title ? { title: metadata.title } : {}),
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

  async recentRuns(): Promise<ToolRun[]> {
    const entries = await readdir(this.#runsDirectory, { withFileTypes: true });
    const runs = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && isRunId(entry.name))
      .map((entry) => this.#readRun(entry.name)));
    return runs
      .filter((run): run is StoredToolRun => Boolean(run))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, HISTORY_LIMIT)
      .map(publicRun);
  }

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string; assetId?: string; title?: string; prompt?: string; publication?: NonNullable<ToolRun["files"][number]["publication"]>; preview?: { bytes: Buffer; mediaType: "image/png" | "image/jpeg" } } | undefined> {
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
      const title = promptTitle(run.prompt) ?? run.title;
      return {
        bytes: await readFile(filePath),
        mediaType: file.mediaType,
        ...(file.assetId ? { assetId: file.assetId } : {}),
        ...(title ? { title } : {}),
        ...(run.prompt ? { prompt: run.prompt } : {}),
        ...(file.publication ? { publication: file.publication } : {}),
        ...(preview ? { preview } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async setFilePublication(runId: string, fileName: string, publication: NonNullable<ToolRun["files"][number]["publication"]>): Promise<void> {
    if (!isRunId(runId) || !isToolRunFileName(fileName)) throw new ToolRunError("Tool output not found", 404);
    const run = await this.#readRun(runId);
    const file = run?.files.find((candidate) => candidate.name === fileName);
    if (!run || !file) throw new ToolRunError("Tool output not found", 404);
    file.publication = publication;
    const runFile = path.join(this.#runsDirectory, runId, "run.json");
    const temporary = `${runFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, runFile);
  }

  async #readRun(runId: string): Promise<StoredToolRun | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.#runsDirectory, runId, "run.json"), "utf8")) as Partial<StoredToolRun>;
      if (value.version !== 1 || value.id !== runId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !isToolId(value.toolId) || !Array.isArray(value.files)) return undefined;
      if (value.title !== undefined && typeof value.title !== "string") return undefined;
      if (value.files.some((file) => !file || typeof file.name !== "string" || typeof file.mediaType !== "string" ||
        file.assetId !== undefined && typeof file.assetId !== "string" ||
        file.publication !== undefined && !isAssetPublication(file.publication))) return undefined;
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

function isAssetPublication(value: unknown): value is NonNullable<ToolRun["files"][number]["publication"]> {
  if (!value || typeof value !== "object") return false;
  const publication = value as Record<string, unknown>;
  return typeof publication.assetId === "string" && typeof publication.releaseId === "string" &&
    typeof publication.publishedAt === "string" && Number.isFinite(Date.parse(publication.publishedAt)) &&
    (publication.status === "listed" || publication.status === "unlisted");
}

function publicRun({ version: _, requestId: __, prompt, preview: ___, ...run }: StoredToolRun): ToolRun {
  const title = promptTitle(prompt) ?? run.title;
  return {
    ...run,
    files: run.files.map(({ assetId: ____, ...file }) => file),
    ...(title ? { title } : {}),
  };
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

function isToolId(value: unknown): value is ToolDefinition["id"] {
  return value === generateImage.id || value === imageTo3D.id || value === generateVideo.id;
}

function imageFileName(mediaType: string, index?: number): string {
  const suffix = index ? `-${index}` : "";
  return mediaType === "image/png" ? `output${suffix}.png` : mediaType === "image/jpeg" ? `output${suffix}.jpg` : `output${suffix}.webp`;
}
