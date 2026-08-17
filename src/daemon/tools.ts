import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_SIZES,
  type ImageSize,
  type RunImageToolRequest,
  type RunImageTo3DToolRequest,
  type RunToolRequest,
  type ToolDefinition,
  type ToolRun,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator } from "./openai-image.js";
import { Meshy3DGenerator, Model3DGenerationError, type Model3DGenerator } from "./meshy-3d.js";

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

interface StoredToolRun extends ToolRun {
  version: 1;
  requestId?: string;
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
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
  }

  list(): ToolDefinition[] {
    return [generateImage, imageTo3D];
  }

  async run(toolId: string, input: RunToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    if (toolId === imageTo3D.id) return this.#runImageTo3D(input as RunImageTo3DToolRequest, signal);
    if (toolId !== generateImage.id) throw new ToolRunError("Tool not found", 404);
    return this.#runImage(input as RunImageToolRequest, signal);
  }

  async #runImage(input: RunImageToolRequest, signal?: AbortSignal): Promise<ToolRun> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const size = input.size ?? "1024x1024";
    if (!isImageSize(size)) throw new ToolRunError("Unsupported image size", 400);

    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const generated = await this.imageGenerator.generate({ prompt, size }, signal);
      signal?.throwIfAborted();
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: generateImage.id,
        createdAt: new Date().toISOString(),
        files: [{ name: "output.webp", mediaType: generated.mediaType }],
        requestId: generated.requestId,
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "output.webp"), generated.bytes);
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
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: imageTo3D.id,
        createdAt: new Date().toISOString(),
        files: [{ name: "model.glb", mediaType: generated.mediaType }],
        requestId: generated.requestId,
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "model.glb"), generated.bytes);
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

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string } | undefined> {
    if (!isRunId(runId) || !["output.webp", "model.glb"].includes(fileName)) return undefined;
    try {
      const directory = path.join(this.#runsDirectory, runId);
      const run = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")) as StoredToolRun;
      const file = run.files.find((candidate) => candidate.name === fileName);
      const filePath = path.join(directory, fileName);
      if (run.version !== 1 || run.id !== runId || !file || !(await stat(filePath)).isFile()) return undefined;
      return { bytes: await readFile(filePath), mediaType: file.mediaType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function isPromptImage(value: unknown): value is RunImageTo3DToolRequest["image"] {
  if (!value || typeof value !== "object") return false;
  const image = value as { mediaType?: unknown; data?: unknown };
  return (image.mediaType === "image/png" || image.mediaType === "image/jpeg") && typeof image.data === "string" && image.data.length > 0;
}

function publicRun({ version: _, requestId: __, ...run }: StoredToolRun): ToolRun {
  return run;
}

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize);
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
