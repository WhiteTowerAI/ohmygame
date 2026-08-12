import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_SIZES,
  type ImageSize,
  type RunImageToolRequest,
  type ToolDefinition,
  type ToolRun,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator } from "./openai-image.js";

const generateImage: ToolDefinition = {
  id: "generate-image",
  name: "Image Generator",
  description: "Generate a game-ready image from a text prompt.",
  category: "images",
  sizes: IMAGE_SIZES,
  defaultSize: "1024x1024",
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
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
  }

  list(): ToolDefinition[] {
    return [generateImage];
  }

  async run(toolId: string, input: RunImageToolRequest): Promise<ToolRun> {
    if (toolId !== generateImage.id) throw new ToolRunError("Tool not found", 404);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const size = input.size ?? generateImage.defaultSize;
    if (!isImageSize(size)) throw new ToolRunError("Unsupported image size", 400);

    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      const generated = await this.imageGenerator.generate({ prompt, size });
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

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string } | undefined> {
    if (!isRunId(runId) || fileName !== "output.webp") return undefined;
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

function publicRun({ version: _, requestId: __, ...run }: StoredToolRun): ToolRun {
  return run;
}

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize);
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
