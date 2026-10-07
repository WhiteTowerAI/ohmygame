import { createHash } from "node:crypto";
import type { Generated3DModel, Model3DAnimationAction, Model3DAnimationInput, Model3DGenerationInput, Model3DGenerator } from "./model3d.js";
import { Model3DGenerationError } from "./model3d.js";
import { mergeAnimationClips } from "./merge-animations.js";
import { ANIMATION_ACTIONS_PER_REQUEST, MAX_ANIMATION_ACTIONS } from "../shared/generation-config.js";

// Image to 3D lives under v1; v2 only serves text-to-3D and answers this path with 404 "Not found".
const BASE_URL = "https://api.meshy.ai/openapi/v1";
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 15 * 60_000;
const MAX_GLB_BYTES = 100 * 1024 * 1024;
/** Consecutive status polls that may fail to connect before the job gives up; one dropped request should not lose a paid task. */
const MAX_POLL_NETWORK_FAILURES = 3;

export class MeshyProvider implements Model3DGenerator {
  /** Rig task IDs by model content and height. Kept in memory only; a restart simply rigs again. */
  readonly #rigs = new Map<string, string>();

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    const meshy = meshyTask(input);
    return this.#session(signal, "Meshy generation timed out", async (apiKey, requestSignal) => {
      const { taskId, task } = await this.#runTask(apiKey, meshy.endpoint, meshy.body, requestSignal, "Meshy generation request failed");
      return { bytes: await this.#downloadGlb(record(task.model_urls).glb, requestSignal), mediaType: "model/gltf-binary", requestId: taskId };
    });
  }

  /**
   * Rigs a humanoid GLB, then bakes the chosen library actions into one file with a clip per action. Meshy caps each
   * animation request, so larger sets run as parallel requests on the same rig and their clips are merged.
   */
  async animate(input: Model3DAnimationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    if (input.actionIds.length < 1 || input.actionIds.length > MAX_ANIMATION_ACTIONS) {
      throw new Model3DGenerationError(`Choose 1 to ${MAX_ANIMATION_ACTIONS} animations`, 400);
    }
    return this.#session(signal, "Meshy animation timed out", async (apiKey, requestSignal) => {
      const rigTaskId = await this.#rig(apiKey, input, requestSignal);
      const batches = await Promise.all(chunks(input.actionIds, ANIMATION_ACTIONS_PER_REQUEST).map(async (actionIds) => {
        const { taskId, task } = await this.#runTask(apiKey, "animations", {
          rig_task_id: rigTaskId,
          action_ids: actionIds,
        }, requestSignal, "Meshy animation request failed");
        return { taskId, bytes: await this.#downloadGlb(record(task.result).animation_glb_url, requestSignal) };
      }));
      const bytes = await mergeAnimationClips(batches.map((batch) => batch.bytes));
      return { bytes, mediaType: "model/gltf-binary", requestId: batches.map((batch) => batch.taskId).join(",") };
    });
  }

  /** Reuses a recent rig of the same model and height, since re-animating a character is common and rigging is billed. */
  async #rig(apiKey: string, input: Model3DAnimationInput, signal: AbortSignal): Promise<string> {
    const key = createHash("sha256").update(input.model).update(`\0${input.heightMeters ?? ""}`).digest("hex");
    const cached = this.#rigs.get(key);
    if (cached && await this.#rigAvailable(apiKey, cached, signal)) return cached;
    this.#rigs.delete(key);
    const { taskId } = await this.#runTask(apiKey, "rigging", {
      model_url: `data:model/gltf-binary;base64,${input.model.toString("base64")}`,
      height_meters: input.heightMeters,
    }, signal, "Meshy rigging request failed");
    this.#rigs.set(key, taskId);
    return taskId;
  }

  /**
   * Status checks are free, so a cached rig is confirmed before animation requests are spent on it. Meshy answers an
   * unknown task ID with some other task of the account rather than a 404, hence the ID check. Any failure just rigs again.
   */
  async #rigAvailable(apiKey: string, taskId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const task = await this.json(`${BASE_URL}/rigging/${encodeURIComponent(taskId)}`, { signal }, apiKey, "Meshy status request failed");
      const expiresAt = task.expires_at;
      return task.id === taskId && string(task.status)?.toUpperCase() === "SUCCEEDED"
        && typeof expiresAt === "number" && expiresAt > Date.now() + MAX_WAIT_MS;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  /** Lists Meshy's preset animations; the call is free, so the daemon can show them before anything is spent. */
  async animations(signal?: AbortSignal): Promise<Model3DAnimationAction[]> {
    return this.#session(signal, "Meshy animation library timed out", async (apiKey, requestSignal) => {
      const body = await this.json(`${BASE_URL}/animations/library`, { signal: requestSignal }, apiKey, "Meshy animation library request failed");
      const items: unknown[] = Array.isArray(body) ? body : [];
      return items.flatMap((item) => {
        const value = record(item);
        const id = value.action_id;
        const name = string(value.name);
        if (typeof id !== "number" || !Number.isInteger(id) || !name) return [];
        return [{
          id,
          name,
          category: string(value.category) ?? "Other",
          subCategory: string(value.sub_category) ?? "Other",
          ...(httpUrl(value.preview_url) ? { previewUrl: value.preview_url } : {}),
        }];
      });
    });
  }

  async #session<T>(signal: AbortSignal | undefined, timeoutMessage: string, run: (apiKey: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.isEnabled()) throw new Model3DGenerationError("Meshy provider is disabled", 409);
    const apiKey = this.apiKey();
    if (!apiKey) throw new Model3DGenerationError("Meshy API key is not configured", 503);
    const timeout = AbortSignal.timeout(MAX_WAIT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await run(apiKey, requestSignal);
    } catch (cause) {
      if (timeout.aborted && !signal?.aborted) throw new Model3DGenerationError(timeoutMessage, 504);
      throw cause;
    }
  }

  /** Creates a task and polls it until it finishes; Meshy's task endpoints all share this shape. */
  async #runTask(apiKey: string, endpoint: string, body: Record<string, unknown>, signal: AbortSignal, message: string): Promise<{ taskId: string; task: Record<string, unknown> }> {
    const created = await this.json(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }, apiKey, message);
    const taskId = string(created.result) ?? string(created.id);
    if (!taskId) throw new Model3DGenerationError("Meshy returned no task ID");
    let networkFailures = 0;
    while (true) {
      signal.throwIfAborted();
      let task: Record<string, unknown>;
      try {
        task = await this.json(`${BASE_URL}/${endpoint}/${encodeURIComponent(taskId)}`, { signal }, apiKey, "Meshy status request failed");
        networkFailures = 0;
      } catch (cause) {
        if (!(cause instanceof MeshyNetworkError) || ++networkFailures >= MAX_POLL_NETWORK_FAILURES) throw cause;
        await delay(this.pollIntervalMs, signal);
        continue;
      }
      const status = string(task.status)?.toUpperCase();
      if (status === "SUCCEEDED" || status === "COMPLETED") return { taskId, task };
      if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
        throw new Model3DGenerationError(string(record(task.task_error).message) ?? string(task.message) ?? `Meshy task ${status.toLowerCase()}`, 400);
      }
      await delay(this.pollIntervalMs, signal);
    }
  }

  async #downloadGlb(url: unknown, signal: AbortSignal): Promise<Buffer> {
    if (!httpUrl(url)) throw new Model3DGenerationError("Meshy task completed without a GLB artifact");
    const content = await this.request(url, { signal });
    if (!content.ok) throw new Model3DGenerationError(`Meshy GLB download failed (${content.status})`, content.status);
    const bytes = Buffer.from(await content.arrayBuffer());
    if (bytes.length > MAX_GLB_BYTES) throw new Model3DGenerationError("Meshy GLB output is too large", 413);
    return bytes;
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

function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
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
