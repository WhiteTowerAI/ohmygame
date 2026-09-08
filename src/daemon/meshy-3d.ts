import type { Model3DModel, Model3DPose, Model3DQuality, Model3DTextureResolution, PromptImage } from "../shared/contracts.js";

interface Model3DGenerationOptions {
  model?: Model3DModel;
  quality?: Model3DQuality;
  targetPolycount?: number;
  texture?: boolean;
  textureResolution?: Model3DTextureResolution;
  pbr?: boolean;
  pose?: Model3DPose;
}

type Text3DGenerationInput = Model3DGenerationOptions & { prompt: string; images?: never; imageEnhancement?: never };
type Image3DGenerationInput = Model3DGenerationOptions & { prompt?: never; images: PromptImage[]; imageEnhancement?: boolean };
export type Model3DGenerationInput = Text3DGenerationInput | Image3DGenerationInput;

export interface Generated3DModel {
  bytes: Buffer;
  mediaType: "model/gltf-binary";
  requestId?: string;
}

export interface Model3DGenerator {
  generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const MAX_GLB_BYTES = 100 * 1024 * 1024;

export class Model3DGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

export class Meshy3DGenerator implements Model3DGenerator {
  constructor(
    private readonly configuration: () => { apiKey?: string; apiUrl: string } = () => ({
      apiKey: process.env.MESHY_API_KEY,
      apiUrl: process.env.MESHY_API_URL ?? "https://api.meshy.ai",
    }),
    private readonly request: Fetch = fetch,
    private readonly pollDelayMs = 2_000,
    private readonly timeoutMs = 15 * 60_000,
  ) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    const { apiKey, apiUrl } = this.configuration();
    if (!apiKey) throw new Model3DGenerationError("3D generation is not configured", 503);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const isText = isTextInput(input);
    if (!isText && (input.images.length < 1 || input.images.length > 4)) {
      throw new Model3DGenerationError("Meshy requires 1 to 4 reference images", 400);
    }
    const isSmartTopology = input.model === "meshy-t2";
    if (!isText && isSmartTopology && input.images.length !== 1) {
      throw new Model3DGenerationError("Meshy T2 requires exactly one reference image", 400);
    }
    if (isSmartTopology && input.quality !== undefined) throw new Model3DGenerationError("Meshy T2 does not support quality modes", 400);
    if (isSmartTopology && !isText && input.imageEnhancement !== undefined) {
      throw new Model3DGenerationError("Meshy T2 does not support image enhancement", 400);
    }
    if (!isSmartTopology && input.targetPolycount !== undefined) throw new Model3DGenerationError("Poly count requires Meshy T2", 400);
    if (isSmartTopology && input.targetPolycount !== undefined
      && (!Number.isInteger(input.targetPolycount) || input.targetPolycount < 100 || input.targetPolycount > 15_000)) {
      throw new Model3DGenerationError("Meshy T2 poly count must be between 100 and 15000", 400);
    }
    const endpoint = isText
      ? textTo3DEndpoint(apiUrl)
      : isSmartTopology ? imageTo3DEndpoint(apiUrl) : multiImageTo3DEndpoint(apiUrl);
    try {
      const requestBody = isText ? textPreviewRequest(input) : isSmartTopology ? imageRequest(input) : multiImageRequest(input);
      const created = await this.createTask(endpoint, apiKey, requestBody, requestSignal);
      let task = await this.waitForTask(endpoint, apiKey, created, requestSignal);
      let requestId = created;

      if (isText && (input.texture ?? true)) {
        requestId = await this.createTask(endpoint, apiKey, textRefineRequest(input, created), requestSignal);
        task = await this.waitForTask(endpoint, apiKey, requestId, requestSignal);
      }

      if (typeof task.model_urls?.glb !== "string") throw new Model3DGenerationError("Meshy returned no GLB model");
      const response = await this.fetch(task.model_urls.glb, {}, requestSignal);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_GLB_BYTES) {
        throw new Model3DGenerationError("Meshy returned a model larger than 100 MB");
      }
      return {
        bytes: await readLimitedBody(response, MAX_GLB_BYTES),
        mediaType: "model/gltf-binary",
        requestId,
      };
    } catch (cause) {
      if (requestSignal.aborted && requestSignal.reason?.name === "TimeoutError") {
        throw new Model3DGenerationError("3D generation timed out", 504);
      }
      throw cause;
    }
  }

  private async createTask(endpoint: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const created = await this.jsonRequest(endpoint, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    }, signal) as { result?: unknown };
    if (typeof created.result !== "string" || !created.result) throw new Model3DGenerationError("Meshy returned no task ID");
    return created.result;
  }

  private async waitForTask(endpoint: string, apiKey: string, taskId: string, signal?: AbortSignal): Promise<{ model_urls?: { glb?: unknown } }> {
    const taskUrl = `${endpoint}/${encodeURIComponent(taskId)}`;
    while (true) {
      const task = await this.jsonRequest(taskUrl, apiKey, { method: "GET" }, signal) as {
        status?: unknown;
        task_error?: { message?: unknown };
        model_urls?: { glb?: unknown };
      };
      if (task.status === "SUCCEEDED") return task;
      if (task.status === "FAILED" || task.status === "CANCELED") {
        const message = typeof task.task_error?.message === "string" ? task.task_error.message : "Meshy 3D generation failed";
        throw new Model3DGenerationError(message, 400);
      }
      await delay(this.pollDelayMs, signal);
    }
  }

  private async jsonRequest(url: string, apiKey: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    }, signal);
    return response.json().catch(() => { throw new Model3DGenerationError("Meshy returned an invalid response"); });
  }

  private async fetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, signal });
    } catch (cause) {
      if (signal?.aborted) {
        if (signal.reason?.name === "TimeoutError") throw new Model3DGenerationError("3D generation timed out", 504);
        throw signal.reason ?? cause;
      }
      throw new Model3DGenerationError("Could not reach Meshy");
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new Model3DGenerationError("Meshy API key was rejected", 503);
    }
    if (response.status === 429) throw new Model3DGenerationError("Meshy is temporarily rate limited", 429);
    const body = await response.json().catch(() => ({})) as { message?: unknown };
    const message = typeof body.message === "string" ? body.message : "Meshy rejected the 3D request";
    throw new Model3DGenerationError(message, response.status < 500 ? 400 : 502);
  }
}

function multiImageTo3DEndpoint(baseUrl: string): string {
  return meshyEndpoint(baseUrl, "/openapi/v1/multi-image-to-3d");
}

function imageTo3DEndpoint(baseUrl: string): string {
  return meshyEndpoint(baseUrl, "/openapi/v1/image-to-3d");
}

function textTo3DEndpoint(baseUrl: string): string {
  return meshyEndpoint(baseUrl, "/openapi/v2/text-to-3d");
}

function meshyEndpoint(baseUrl: string, endpointPath: string): string {
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, "")}${endpointPath}`;
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Model3DGenerationError("Meshy base URL is not valid", 503);
  }
}

function multiImageRequest(input: Image3DGenerationInput): Record<string, unknown> {
  const texture = input.texture ?? true;
  return {
    image_urls: input.images.map(promptImageDataUri),
    ai_model: input.model ?? "meshy-7",
    ultra_mode: input.quality === "ultra",
    should_texture: texture,
    texture_resolution: (input.textureResolution ?? "2K").toLowerCase(),
    enable_pbr: texture && (input.pbr ?? false),
    pose_mode: poseMode(input.pose),
    image_enhancement: input.imageEnhancement ?? true,
    should_remesh: false,
    target_formats: ["glb"],
  };
}

function imageRequest(input: Image3DGenerationInput): Record<string, unknown> {
  const texture = input.texture ?? true;
  return {
    image_url: promptImageDataUri(input.images[0]!),
    model_type: "smart-topology",
    ai_model: "meshy-t2",
    target_polycount: input.targetPolycount ?? 4_000,
    should_texture: texture,
    texture_resolution: (input.textureResolution ?? "2K").toLowerCase(),
    enable_pbr: texture && (input.pbr ?? false),
    pose_mode: poseMode(input.pose),
    target_formats: ["glb"],
  };
}

function textPreviewRequest(input: Text3DGenerationInput): Record<string, unknown> {
  if (input.model === "meshy-t2") {
    return {
      mode: "preview",
      prompt: input.prompt,
      model_type: "smart-topology",
      ai_model: "meshy-t2",
      target_polycount: input.targetPolycount ?? 4_000,
      pose_mode: poseMode(input.pose),
      target_formats: ["glb"],
    };
  }
  return {
    mode: "preview",
    prompt: input.prompt,
    ai_model: input.model ?? "meshy-7",
    model_type: "standard",
    ultra_mode: input.quality === "ultra",
    pose_mode: poseMode(input.pose),
    should_remesh: false,
    target_formats: ["glb"],
  };
}

function promptImageDataUri(image: PromptImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

function textRefineRequest(input: Text3DGenerationInput, previewTaskId: string): Record<string, unknown> {
  return {
    mode: "refine",
    preview_task_id: previewTaskId,
    ...(input.model === "meshy-t2" ? {} : { ai_model: input.model ?? "meshy-7" }),
    enable_pbr: input.pbr ?? false,
    texture_resolution: (input.textureResolution ?? "2K").toLowerCase(),
    target_formats: ["glb"],
  };
}

function poseMode(pose: Model3DPose | undefined): string {
  return pose === "a-pose" || pose === "t-pose" ? pose : "";
}

function isTextInput(input: Model3DGenerationInput): input is Text3DGenerationInput {
  return input.prompt !== undefined;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Model3DGenerationError("Meshy returned no GLB model");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Model3DGenerationError("Meshy returned a model larger than 100 MB");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
