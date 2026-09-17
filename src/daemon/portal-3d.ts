import type {
  Generated3DModel,
  Image3DGenerationInput,
  Model3DGenerationInput,
  Model3DGenerator,
} from "./model3d.js";
import { Model3DGenerationError } from "./model3d.js";

const DEFAULT_MODEL = "meshy-7";
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60_000;
const MAX_GLB_BYTES = 100 * 1024 * 1024;
const IMAGE_VIEWS = ["front", "left", "back", "right"] as const;

export interface Model3DSource {
  baseUrl: string;
  apiKey: string;
  modelIds: readonly string[];
}

interface Model3DTask {
  id?: unknown;
  status?: unknown;
  artifacts?: unknown;
  error?: unknown;
}

interface Model3DArtifact {
  contentUrl: string;
}

/** Uses New API's provider-independent 3D generation contract. */
export class Portal3DGenerator implements Model3DGenerator {
  constructor(
    private readonly source: () => Model3DSource | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  async generate(
    input: Model3DGenerationInput,
    signal?: AbortSignal,
  ): Promise<Generated3DModel> {
    const model = input.model ?? DEFAULT_MODEL;
    validateInput(input, model);
    const source = this.source();
    if (!source || !source.modelIds.includes(model)) {
      throw new Model3DGenerationError(
        `${modelName(model)} is not available through OpenGame Portal`,
        503,
      );
    }
    const timeout = AbortSignal.timeout(this.maxWaitMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.generateWithSource(source, input, model, requestSignal);
    } catch (cause) {
      if (timeout.aborted && !signal?.aborted) {
        throw new Model3DGenerationError("3D generation timed out", 504);
      }
      throw cause;
    }
  }

  private async generateWithSource(
    source: Model3DSource,
    input: Model3DGenerationInput,
    model: "meshy-7" | "meshy-t2",
    signal: AbortSignal,
  ): Promise<Generated3DModel> {
    const created = await this.jsonRequest(
      source,
      "/3d/generations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(generationRequest(input, model)),
        signal,
      },
      "3D generation request failed",
    );
    const requestId = string(created.id);
    if (!requestId) {
      throw new Model3DGenerationError("3D provider returned no task ID");
    }

    while (true) {
      signal.throwIfAborted();
      const task = await this.jsonRequest(
        source,
        `/3d/generations/${encodeURIComponent(requestId)}`,
        { signal },
        "3D status request failed",
      );
      const status = string(task.status)?.toLowerCase();
      if (status === "completed") {
        const artifact = firstGLBArtifact(task.artifacts);
        if (!artifact) {
          throw new Model3DGenerationError(
            "3D task completed without a GLB artifact",
          );
        }
        const content = await this.fetch(
          source,
          artifactPath(source.baseUrl, artifact.contentUrl),
          { signal },
        );
        return {
          bytes: await readLimitedGLB(content),
          mediaType: "model/gltf-binary",
          requestId,
        };
      }
      if (status === "failed" || status === "cancelled") {
        const error = record(task.error);
        throw new Model3DGenerationError(
          string(error.message) ?? `3D generation ${status}`,
          400,
        );
      }
      await delay(this.pollIntervalMs, signal);
    }
  }

  private async jsonRequest(
    source: Model3DSource,
    path: string,
    init: RequestInit,
    message: string,
  ): Promise<Model3DTask> {
    const response = await this.fetch(source, path, init);
    const value = await response.json().catch(() => {
      throw new Model3DGenerationError(`${message}: invalid response`);
    });
    return record(value);
  }

  private async fetch(
    source: Model3DSource,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(endpoint(source.baseUrl, path), {
        ...init,
        headers: { authorization: `Bearer ${source.apiKey}`, ...init.headers },
      });
    } catch (cause) {
      if (init.signal?.aborted) throw init.signal.reason ?? cause;
      throw new Model3DGenerationError("Could not reach New API");
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new Model3DGenerationError(
        "OpenGame Portal connection is no longer authorized",
        503,
      );
    }
    if (response.status === 429) {
      throw new Model3DGenerationError(
        "3D generation is temporarily rate limited",
        429,
      );
    }
    const body = record(await response.json().catch(() => ({})));
    const error = record(body.error);
    const message =
      string(error.message) ??
      string(body.message) ??
      `3D request failed (${response.status})`;
    throw new Model3DGenerationError(
      message,
      response.status < 500 ? 400 : 502,
    );
  }
}

function validateInput(
  input: Model3DGenerationInput,
  model: string,
): asserts input is Model3DGenerationInput {
  if (model !== "meshy-7" && model !== "meshy-t2") {
    throw new Model3DGenerationError("Unsupported 3D model", 400);
  }
  const isText = typeof input.prompt === "string";
  if (model === "meshy-t2") {
    if (isText) {
      throw new Model3DGenerationError(
        "Meshy T2 requires exactly one reference image",
        400,
      );
    }
    validateT2Input(input);
    return;
  }
  if (isText) {
    if (!input.prompt.trim()) {
      throw new Model3DGenerationError("3D prompt must not be empty", 400);
    }
  } else if (input.images.length < 1 || input.images.length > 4) {
    throw new Model3DGenerationError(
      "Meshy 7 requires 1 to 4 reference images",
      400,
    );
  }
  if (input.targetPolycount !== undefined) {
    throw new Model3DGenerationError("Poly count requires Meshy T2", 400);
  }
}

function validateT2Input(input: Image3DGenerationInput): void {
  if (input.images.length !== 1) {
    throw new Model3DGenerationError(
      "Meshy T2 requires exactly one reference image",
      400,
    );
  }
  if (input.quality !== undefined) {
    throw new Model3DGenerationError(
      "Meshy T2 does not support quality modes",
      400,
    );
  }
  if (input.imageEnhancement !== undefined) {
    throw new Model3DGenerationError(
      "Meshy T2 does not support image enhancement",
      400,
    );
  }
  if (input.textureResolution !== undefined && input.textureResolution !== "2K") {
    throw new Model3DGenerationError("Meshy T2 supports only 2K textures", 400);
  }
  if (input.pose !== undefined && input.pose !== "auto") {
    throw new Model3DGenerationError(
      "Meshy T2 does not support pose control",
      400,
    );
  }
}

function generationRequest(
  input: Model3DGenerationInput,
  model: "meshy-7" | "meshy-t2",
): Record<string, unknown> {
  if (model === "meshy-t2") return t2Request(input as Image3DGenerationInput);
  return meshy7Request(input);
}

function t2Request(input: Image3DGenerationInput): Record<string, unknown> {
  return {
    model: "meshy-t2",
    input: imageInput(input.images),
    geometry: {
      target_face_count: input.targetPolycount ?? 4_000,
      topology: "triangle",
    },
    material: {
      enabled: input.texture ?? true,
      pbr: input.texture === false ? false : input.pbr ?? false,
      texture_resolution: "2k",
    },
    output: { formats: ["glb"] },
  };
}

function meshy7Request(input: Model3DGenerationInput): Record<string, unknown> {
  const texture = input.texture ?? true;
  return {
    model: "meshy-7",
    quality: input.quality ?? "standard",
    input: typeof input.prompt === "string"
      ? { type: "text", prompt: input.prompt.trim() }
      : {
          ...imageInput(input.images),
          image_enhancement: input.imageEnhancement ?? true,
        },
    geometry: { pose: input.pose ?? "auto" },
    material: {
      enabled: texture,
      pbr: texture && (input.pbr ?? false),
      texture_resolution: (input.textureResolution ?? "2K").toLowerCase(),
    },
    output: { formats: ["glb"] },
  };
}

function imageInput(images: Image3DGenerationInput["images"]): Record<string, unknown> {
  return {
    type: images.length === 1 ? "image" : "images",
    images: images.map((image, index) => ({
      data: `data:${image.mediaType};base64,${image.data}`,
      view: IMAGE_VIEWS[index],
    })),
  };
}

function firstGLBArtifact(value: unknown): Model3DArtifact | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const candidate of value) {
    const artifact = record(candidate);
    const contentUrl = string(artifact.content_url);
    if (contentUrl && artifact.format === "glb" && artifact.kind === "model") {
      return { contentUrl };
    }
  }
  return undefined;
}

function artifactPath(baseUrl: string, contentUrl: string): string {
  try {
    const base = new URL(baseUrl);
    const target = new URL(contentUrl, base);
    const basePath = base.pathname.replace(/\/$/, "");
    if (
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.hash ||
      (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))
    ) {
      throw new Error();
    }
    return `${target.pathname.slice(basePath.length)}${target.search}`;
  } catch {
    throw new Model3DGenerationError("3D artifact URL is not trusted");
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function modelName(model: string): string {
  return model === "meshy-t2" ? "Meshy T2" : "Meshy 7";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readLimitedGLB(response: Response): Promise<Buffer> {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mediaType !== "model/gltf-binary" &&
    mediaType !== "application/octet-stream"
  ) {
    throw new Model3DGenerationError(
      "3D artifact response has an invalid content type",
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_GLB_BYTES) {
    throw new Model3DGenerationError("3D model is larger than 100 MB");
  }
  if (!response.body) {
    throw new Model3DGenerationError("3D artifact response was empty");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GLB_BYTES) {
        throw new Model3DGenerationError("3D model is larger than 100 MB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
