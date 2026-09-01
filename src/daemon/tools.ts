import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type VideoAspectRatio,
  type VideoResolution,
  type ImageSize,
  type RunImageToolRequest,
  type RunImageTo3DToolRequest,
  type RunVideoToolRequest,
  type RunToolRequest,
  type ToolDefinition,
  type ToolRun,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator } from "./openai-image.js";
import { Meshy3DGenerator, Model3DGenerationError, type Model3DGenerator } from "./meshy-3d.js";
import { VideoGenerationError, type VideoGenerator } from "./minimax-video.js";

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
  name: "Image to 3D",
  description: "Turn a reference image into a textured 3D model.",
  category: "3d",
  inputKind: "image",
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
  aspectRatios: VIDEO_ASPECT_RATIOS,
  resolutions: VIDEO_RESOLUTIONS,
  durations: VIDEO_DURATIONS,
};

interface StoredToolRun extends ToolRun {
  version: 1;
  requestId?: string;
  prompt?: string;
  preview?: { fileName: string; mediaType: "image/png" | "image/jpeg" };
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
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
  }

  list(): ToolDefinition[] {
    return [generateImage, imageTo3D, generateVideo];
  }

  async run(toolId: string, input: RunToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    if (toolId === imageTo3D.id) {
      assertOnlyKeys(input, ["image"]);
      return this.#runImageTo3D(input as RunImageTo3DToolRequest, signal);
    }
    if (toolId === generateVideo.id) {
      assertOnlyKeys(input, ["prompt", "image", "duration", "aspectRatio", "resolution"]);
      return this.#runVideo(input as RunVideoToolRequest, signal);
    }
    if (toolId !== generateImage.id) throw new ToolRunError("Tool not found", 404);
    assertOnlyKeys(input, ["prompt", "size", "resolution", "aspectRatio", "outputs", "image"]);
    return this.#runImage(input as RunImageToolRequest, signal);
  }

  async #runImage(input: RunImageToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const usesStudioOptions = input.resolution !== undefined || input.aspectRatio !== undefined || input.outputs !== undefined || input.image !== undefined;
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
    if (input.image && !isPromptImage(input.image, true)) throw new ToolRunError("A PNG, JPEG, or WebP image is required", 400);

    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const generated = await Promise.all(Array.from({ length: outputs }, () => this.imageGenerator.generate({
        prompt,
        ...(usesStudioOptions ? { resolution: resolution!, aspectRatio: aspectRatio!, ...(input.image ? { image: input.image } : {}) } : { size }),
      }, signal)));
      signal?.throwIfAborted();
      const files = generated.map((image, index) => ({
        name: imageFileName(image.mediaType, outputs > 1 ? index + 1 : undefined),
        mediaType: image.mediaType,
      }));
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: generateImage.id,
        createdAt: new Date().toISOString(),
        files,
        prompt,
      };
      await mkdir(temporary, { recursive: true });
      await Promise.all(generated.map((image, index) => writeFile(path.join(temporary, files[index]!.name), image.bytes)));
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof ImageGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #runImageTo3D(input: RunImageTo3DToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    if (!isPromptImage(input.image)) throw new ToolRunError("A PNG or JPEG image is required", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const generated = await this.model3DGenerator.generate({ image: input.image }, signal);
      signal?.throwIfAborted();
      const preview = {
        fileName: `preview.${input.image.mediaType === "image/png" ? "png" : "jpg"}`,
        mediaType: input.image.mediaType as "image/png" | "image/jpeg",
      };
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: imageTo3D.id,
        createdAt: new Date().toISOString(),
        files: [{ name: "model.glb", mediaType: generated.mediaType }],
        requestId: generated.requestId,
        preview,
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "model.glb"), generated.bytes);
      await writeFile(path.join(temporary, preview.fileName), Buffer.from(input.image.data, "base64"));
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof Model3DGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #runVideo(input: RunVideoToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    if (!this.videoGenerator) throw new ToolRunError("Video generation is not configured", 503);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    if (input.image && !isPromptImage(input.image)) throw new ToolRunError("A PNG or JPEG image is required", 400);
    const duration = input.duration ?? VIDEO_DEFAULT_DURATION;
    if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new ToolRunError("Unsupported video duration", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const aspectRatio = input.aspectRatio ?? "16:9";
      const resolution = input.resolution ?? "720p";
      if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio as VideoAspectRatio)) throw new ToolRunError("Unsupported video aspect ratio", 400);
      if (!VIDEO_RESOLUTIONS.includes(resolution as VideoResolution)) throw new ToolRunError("Unsupported video resolution", 400);
      const generated = await this.videoGenerator.generate({ prompt, image: input.image, duration, size: videoSize(aspectRatio, resolution) }, signal);
      signal?.throwIfAborted();
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: generateVideo.id,
        createdAt: new Date().toISOString(),
        files: [{ name: "output.mp4", mediaType: generated.mediaType }],
        requestId: generated.requestId,
        prompt,
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "output.mp4"), generated.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof VideoGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string; prompt?: string; preview?: { bytes: Buffer; mediaType: "image/png" | "image/jpeg" } } | undefined> {
    if (!isRunId(runId) || !/^(?:output(?:-[1-4])?\.(?:png|jpg|webp)|model\.glb|output\.mp4)$/.test(fileName)) return undefined;
    try {
      const directory = path.join(this.#runsDirectory, runId);
      const run = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")) as StoredToolRun;
      const file = run.files.find((candidate) => candidate.name === fileName);
      const filePath = path.join(directory, fileName);
      if (run.version !== 1 || run.id !== runId || !file || !(await stat(filePath)).isFile()) return undefined;
      const preview = run.preview
        ? { bytes: await readFile(path.join(directory, run.preview.fileName)), mediaType: run.preview.mediaType }
        : undefined;
      return { bytes: await readFile(filePath), mediaType: file.mediaType, ...(run.prompt ? { prompt: run.prompt } : {}), ...(preview ? { preview } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function videoSize(aspectRatio: VideoAspectRatio, resolution: VideoResolution): string {
  const large = resolution === "1080p";
  if (aspectRatio === "9:16") return large ? "1080x1920" : "720x1280";
  if (aspectRatio === "1:1") return large ? "1080x1080" : "720x720";
  return large ? "1920x1080" : "1280x720";
}

function isPromptImage(value: unknown, allowWebP = false): value is RunImageTo3DToolRequest["image"] {
  if (!value || typeof value !== "object") return false;
  const image = value as { mediaType?: unknown; data?: unknown };
  return (image.mediaType === "image/png" || image.mediaType === "image/jpeg" || (allowWebP && image.mediaType === "image/webp")) && typeof image.data === "string" && image.data.length > 0;
}

function publicRun({ version: _, requestId: __, prompt: ___, preview: ____, ...run }: StoredToolRun): ToolRun {
  return run;
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

function imageFileName(mediaType: string, index?: number): string {
  const suffix = index ? `-${index}` : "";
  return mediaType === "image/png" ? `output${suffix}.png` : mediaType === "image/jpeg" ? `output${suffix}.jpg` : `output${suffix}.webp`;
}
