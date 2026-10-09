import { setTimeout as delay } from "node:timers/promises";
import type { CustomModel3DSettings } from "../shared/contracts.js";
import { resolveModel3D } from "../shared/generation-config.js";
import type { ImageSource } from "./image-adapters.js";
import { Model3DGenerationError, type Generated3DModel, type Model3DGenerationInput, type Model3DGenerator } from "./model3d.js";

const BASE_URL = "https://openapi.tripo3d.ai/v3";
const MAX_WAIT_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GLB_BYTES = 100 * 1024 * 1024;
const VIEW_NAMES = ["front", "left", "back", "right"] as const;

/** Tripo V3: upload private images, submit one task, poll and download its GLB. */
export class TripoProvider implements Model3DGenerator {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = 2_000,
    private readonly isEnabled: () => boolean = () => true,
    private readonly connection?: ImageSource & { settings: CustomModel3DSettings },
  ) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    if (!this.isEnabled()) throw new Model3DGenerationError("Tripo provider is disabled", 409);
    const key = this.apiKey();
    if (!key && this.connection?.authentication !== "none") throw new Model3DGenerationError("Tripo API key is not configured", 503);
    const model = this.connection?.settings ?? (input.model.provider === "tripo" ? resolveModel3D(input.model) : undefined);
    if (!model) throw new Model3DGenerationError("The selected Tripo model is unavailable", 400);
    if (!input.images.length || input.images.length > model.maxReferenceImages) throw new Model3DGenerationError(`Provide 1 to ${model.maxReferenceImages} reference images`, 400);
    const polycount = input.targetPolycount ?? model.polycount.default;
    if (!Number.isInteger(polycount) || polycount < model.polycount.min || polycount > model.polycount.max) throw new Model3DGenerationError(`Tripo face count must be between ${model.polycount.min} and ${model.polycount.max}`, 400);
    const images = input.images.map((image) => {
      const bytes = Buffer.from(image.data, "base64");
      if (!["image/png", "image/jpeg"].includes(image.mediaType) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Model3DGenerationError("Tripo references must be PNG or JPEG images up to 20 MB", 400);
      return { ...image, bytes };
    });
    const timeout = AbortSignal.timeout(MAX_WAIT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      requestSignal.throwIfAborted();
      const tokens: string[] = [];
      for (const image of images) {
        const form = new FormData();
        form.set("file", new Blob([image.bytes], { type: image.mediaType }), `reference.${image.mediaType === "image/png" ? "png" : "jpg"}`);
        const uploaded = await this.#json("files", { method: "POST", body: form, signal: requestSignal }, key);
        if (typeof uploaded.file_token !== "string" || !uploaded.file_token) throw new Model3DGenerationError("Tripo returned no upload token");
        tokens.push(uploaded.file_token);
      }
      const texture = input.texture ?? true;
      const created = await this.#json(`generation/${tokens.length === 1 ? "image-to-model" : "multiview-to-model"}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: requestSignal,
        body: JSON.stringify({ model: input.model.id, face_limit: polycount, texture, pbr: texture && (input.pbr ?? false),
          ...(tokens.length === 1 ? { input: tokens[0] } : { inputs: tokens.map((token, index) => ({ [VIEW_NAMES[index]!]: token })) }),
        }),
      }, key);
      const taskId = created.task_id;
      if (typeof taskId !== "string" || !taskId) throw new Model3DGenerationError("Tripo returned no task ID");
      let failures = 0;
      while (true) {
        requestSignal.throwIfAborted();
        let task: Record<string, unknown>;
        try {
          task = await this.#json(`tasks/${encodeURIComponent(taskId)}`, { signal: requestSignal }, key);
          failures = 0;
        } catch (cause) {
          if (!(cause instanceof TripoNetworkError) || ++failures >= 3) throw cause;
          await delay(this.pollIntervalMs, undefined, { signal: requestSignal });
          continue;
        }
        if (task.status === "success") {
          const url = record(task.output).model_url;
          if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Model3DGenerationError("Tripo completed without a GLB artifact");
          // Signed output URLs are fetched without the provider's API key or custom headers.
          const response = await this.request(url, { signal: requestSignal });
          if (!response.ok) throw new Model3DGenerationError(`Tripo GLB download failed (${response.status})`);
          if (Number(response.headers.get("content-length")) > MAX_GLB_BYTES) throw new Model3DGenerationError("Tripo GLB output is too large", 413);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > MAX_GLB_BYTES) throw new Model3DGenerationError("Tripo GLB output is too large", 413);
          return { bytes, mediaType: "model/gltf-binary", requestId: taskId };
        }
        if (["failed", "cancelled", "canceled"].includes(String(task.status))) throw new Model3DGenerationError(typeof task.error_message === "string" ? task.error_message : `Tripo task ${task.status}`, 400);
        if (!["queued", "running"].includes(String(task.status))) throw new Model3DGenerationError("Tripo returned an unknown task status");
        await delay(this.pollIntervalMs, undefined, { signal: requestSignal });
      }
    } catch (cause) {
      if (timeout.aborted && !signal?.aborted) throw new Model3DGenerationError("Tripo generation timed out", 504);
      throw cause;
    }
  }

  async #json(endpoint: string, init: RequestInit, key?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(`${(this.connection?.baseUrl ?? BASE_URL).replace(/\/+$/, "")}/${endpoint}`, { ...init, headers: {
        ...this.connection?.headers, ...(this.connection?.authentication === "none" ? {} : { authorization: `Bearer ${key}` }), ...init.headers,
      } });
    } catch (cause) {
      if (init.signal?.aborted) throw init.signal.reason ?? cause;
      throw new TripoNetworkError(`Could not reach Tripo (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    const body = record(await response.json().catch(() => undefined));
    if (response.ok && body.code === 0 && body.data && typeof body.data === "object") return record(body.data);
    const message = typeof body.message === "string" ? body.message : "Invalid API response";
    if (response.status === 401 || body.code === 1000 || body.code === 1001) throw new Model3DGenerationError("Tripo API key was rejected", 503);
    if (response.status === 429 || body.code === 2000) throw new Model3DGenerationError("Tripo is temporarily rate limited", 429);
    throw new Model3DGenerationError(`Tripo: ${message}`, response.status >= 500 || response.ok ? 502 : 400);
  }
}

class TripoNetworkError extends Model3DGenerationError {
  constructor(message: string) { super(message, 502); }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
