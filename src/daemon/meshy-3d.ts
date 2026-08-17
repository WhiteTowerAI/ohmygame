import type { PromptImage } from "../shared/contracts.js";

export interface Generated3DModel {
  bytes: Buffer;
  mediaType: "model/gltf-binary";
  requestId?: string;
}

export interface Model3DGenerator {
  generate(input: { image: PromptImage }, signal?: AbortSignal): Promise<Generated3DModel>;
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

  async generate(input: { image: PromptImage }, signal?: AbortSignal): Promise<Generated3DModel> {
    const { apiKey, apiUrl } = this.configuration();
    if (!apiKey) throw new Model3DGenerationError("3D generation is not configured", 503);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const endpoint = imageTo3DEndpoint(apiUrl);
    try {
      const created = await this.jsonRequest(endpoint, apiKey, {
        method: "POST",
        body: JSON.stringify({
          image_url: `data:${input.image.mediaType};base64,${input.image.data}`,
          ai_model: "latest",
          should_texture: true,
          enable_pbr: true,
        }),
      }, requestSignal) as { result?: unknown };
      if (typeof created.result !== "string" || !created.result) {
        throw new Model3DGenerationError("Meshy returned no task ID");
      }

      const taskUrl = `${endpoint}/${encodeURIComponent(created.result)}`;
      while (true) {
        const task = await this.jsonRequest(taskUrl, apiKey, { method: "GET" }, requestSignal) as {
          status?: unknown;
          task_error?: { message?: unknown };
          model_urls?: { glb?: unknown };
        };
        if (task.status === "SUCCEEDED") {
          if (typeof task.model_urls?.glb !== "string") {
            throw new Model3DGenerationError("Meshy returned no GLB model");
          }
          const response = await this.fetch(task.model_urls.glb, {}, requestSignal);
          const contentLength = Number(response.headers.get("content-length"));
          if (Number.isFinite(contentLength) && contentLength > MAX_GLB_BYTES) {
            throw new Model3DGenerationError("Meshy returned a model larger than 100 MB");
          }
          const bytes = await readLimitedBody(response, MAX_GLB_BYTES);
          return {
            bytes,
            mediaType: "model/gltf-binary",
            requestId: created.result,
          };
        }
        if (task.status === "FAILED" || task.status === "CANCELED") {
          const message = typeof task.task_error?.message === "string" ? task.task_error.message : "Meshy 3D generation failed";
          throw new Model3DGenerationError(message, 400);
        }
        await delay(this.pollDelayMs, requestSignal);
      }
    } catch (cause) {
      if (requestSignal.aborted && requestSignal.reason?.name === "TimeoutError") {
        throw new Model3DGenerationError("3D generation timed out", 504);
      }
      throw cause;
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

function imageTo3DEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, "")}/openapi/v1/image-to-3d`;
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Model3DGenerationError("Meshy base URL is not valid", 503);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
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
