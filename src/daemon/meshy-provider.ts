import type { Model3DGenerationInput, Model3DGenerator, Generated3DModel } from "./model3d.js";
import { Model3DGenerationError } from "./model3d.js";

// Image to 3D lives under v1; v2 only serves text-to-3D and answers this path with 404 "Not found".
const BASE_URL = "https://api.meshy.ai/openapi/v1";
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60_000;
const MAX_GLB_BYTES = 100 * 1024 * 1024;
/** Consecutive status polls that may fail to connect before the job gives up; one dropped request should not lose a paid task. */
const MAX_POLL_NETWORK_FAILURES = 3;

export class MeshyProvider implements Model3DGenerator {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    const meshy = meshyTask(input);
    const apiKey = this.apiKey();
    if (!apiKey) throw new Model3DGenerationError("Meshy API key is not configured", 503);
    const timeout = AbortSignal.timeout(MAX_WAIT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const created = await this.json(`${BASE_URL}/${meshy.endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(meshy.body),
        signal: requestSignal,
      }, apiKey, "Meshy generation request failed");
      const taskId = string(created.result) ?? string(created.id);
      if (!taskId) throw new Model3DGenerationError("Meshy returned no task ID");
      let networkFailures = 0;
      while (true) {
        requestSignal.throwIfAborted();
        let task: Record<string, unknown>;
        try {
          task = await this.json(
            `${BASE_URL}/${meshy.endpoint}/${encodeURIComponent(taskId)}`,
            { signal: requestSignal },
            apiKey,
            "Meshy status request failed",
          );
          networkFailures = 0;
        } catch (cause) {
          if (!(cause instanceof MeshyNetworkError) || ++networkFailures >= MAX_POLL_NETWORK_FAILURES) throw cause;
          await delay(this.pollIntervalMs, requestSignal);
          continue;
        }
        const status = string(task.status)?.toUpperCase();
        if (status === "SUCCEEDED" || status === "COMPLETED") {
          const url = record(task.model_urls).glb;
          if (!httpUrl(url)) throw new Model3DGenerationError("Meshy task completed without a GLB artifact");
          const content = await this.request(url, { signal: requestSignal });
          if (!content.ok) throw new Model3DGenerationError(`Meshy GLB download failed (${content.status})`, content.status);
          const bytes = Buffer.from(await content.arrayBuffer());
          if (bytes.length > MAX_GLB_BYTES) throw new Model3DGenerationError("Meshy GLB output is too large", 413);
          return { bytes, mediaType: "model/gltf-binary", requestId: taskId };
        }
        if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
          throw new Model3DGenerationError(string(task.message) ?? `Meshy task ${status.toLowerCase()}`, 400);
        }
        await delay(this.pollIntervalMs, requestSignal);
      }
    } catch (cause) {
      if (timeout.aborted && !signal?.aborted) throw new Model3DGenerationError("Meshy generation timed out", 504);
      if (cause instanceof Model3DGenerationError) throw cause;
      throw cause;
    }
  }

  private async json(url: string, init: RequestInit, apiKey: string, message: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, headers: { authorization: `Bearer ${apiKey}`, ...init.headers } });
    } catch (cause) {
      if (init.signal?.aborted) throw init.signal.reason ?? cause;
      throw new MeshyNetworkError(cause);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) return body;
    if (response.status === 401 || response.status === 403) throw new Model3DGenerationError("Meshy API key was rejected", 503);
    if (response.status === 429) throw new Model3DGenerationError("Meshy is temporarily rate limited", 429);
    throw new Model3DGenerationError(`Meshy ${response.status}: ${string(body.message) ?? message}`, response.status >= 500 ? 502 : 400);
  }
}

class MeshyNetworkError extends Model3DGenerationError {
  constructor(cause: unknown) {
    super(`Could not reach Meshy (${networkErrorDetail(cause)})`, 502);
  }
}

/** fetch only says "fetch failed"; the useful part (ECONNRESET, connect timeout, ...) sits on its cause. */
function networkErrorDetail(cause: unknown): string {
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  if (!(inner instanceof Error)) return String(inner);
  const code = (inner as { code?: unknown }).code;
  return typeof code === "string" && !inner.message.includes(code) ? `${code}: ${inner.message}` : inner.message;
}

/** Meshy runs T2 and 7.1 on different endpoints with different polycount controls. */
function meshyTask(input: Model3DGenerationInput): { endpoint: string; body: Record<string, unknown> } {
  const texture = {
    should_texture: input.texture ?? true,
    enable_pbr: input.texture === false ? false : input.pbr ?? false,
  };
  const images = input.images.map((image) => `data:${image.mediaType};base64,${image.data}`);
  if (input.model.provider === "meshy" && input.model.id === "meshy-t2") {
    if (images.length !== 1) throw new Model3DGenerationError("Meshy T2 requires exactly one reference image", 400);
    return {
      endpoint: "image-to-3d",
      // Smart Topology generates straight at the target face count, so no remesh pass is involved.
      body: { image_url: images[0], model_type: "smart-topology", ai_model: "meshy-t2", ...texture, target_polycount: input.targetPolycount ?? 4_000 },
    };
  }
  if (input.model.provider === "meshy" && input.model.id === "meshy-7.1") {
    if (images.length < 1 || images.length > 4) throw new Model3DGenerationError("Meshy 7.1 takes 1 to 4 reference images", 400);
    return {
      // The multi-image endpoint accepts a single view too, so one endpoint covers 7.1; the first image is the front.
      endpoint: "multi-image-to-3d",
      // Standard models only honour target_polycount through the remesh pass.
      body: { image_urls: images, ai_model: "meshy-7.1", ...texture, should_remesh: true, topology: "triangle", target_polycount: input.targetPolycount ?? 30_000 },
    };
  }
  throw new Model3DGenerationError(`Meshy does not offer ${input.model.provider}/${input.model.id}`, 400);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: unknown): value is string {
  return Boolean(string(value)?.match(/^https?:\/\//));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
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
