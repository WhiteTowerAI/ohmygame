import { setTimeout as delay } from "node:timers/promises";
import type { CustomModel3DSettings, Model3DBalance, Model3DOptions } from "../shared/contracts.js";
import { model3DPreset } from "../shared/model3d-presets.js";
import { remeshPolycount, tripoActions } from "../shared/model3d-operations.js";
import { MAX_ANIMATION_ACTIONS } from "../shared/generation-config.js";
import type { ImageSource } from "./image-adapters.js";
import { Model3DGenerationError, readModel3DResult, type Generated3DModel, type Model3DGenerationInput, type Model3DAnimationInput, type Model3DExecution, type Model3DGenerator } from "./model3d.js";

const BASE_URL = "https://openapi.tripo3d.ai/v3";
const VIEW_NAMES = ["front", "left", "back", "right"] as const;

export class TripoProvider implements Model3DGenerator {
  constructor(private readonly apiKey: () => string | undefined, private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = 2_000, private readonly isEnabled: () => boolean = () => true,
    private readonly connection?: ImageSource & { settings: CustomModel3DSettings }) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal, settings?: CustomModel3DSettings): Promise<Generated3DModel> {
    const model = settings ?? this.connection?.settings ?? model3DPreset(input.model.provider, input.model.id)?.settings;
    if (!model || model.protocol !== "tripo") throw new Model3DGenerationError("The selected Tripo model is unavailable", 400);
    const operation = input.operation ?? "image";
    if (input.options?.textureQuality === "fast" && input.options?.textureModel && input.options.textureModel !== "v3.5-20260815") throw new Model3DGenerationError("Fast textures require Tripo v3.5", 400);
    if (operation === "image" && (!input.images.length || input.images.length > model.maxReferenceImages)) throw new Model3DGenerationError(`Provide 1 to ${model.maxReferenceImages} reference images`, 400);
    if (operation === "text" && (input.images.length || !input.prompt?.trim() || input.prompt.length > 1024)) throw new Model3DGenerationError("Tripo text generation needs a prompt up to 1024 characters", 400);
    const polycount = operation === "remesh" ? remeshPolycount("tripo") : model.polycount;
    const faces = input.targetPolycount ?? polycount.default;
    if (operation !== "retexture" && (!Number.isInteger(faces) || faces < polycount.min || faces > polycount.max)) throw new Model3DGenerationError(`Tripo face count must be between ${polycount.min} and ${polycount.max}`, 400);
    const texture = input.texture ?? model.defaults?.texture ?? model.supportsTexture;
    const pbr = texture && (input.pbr ?? model.defaults?.pbr ?? false);
    if (texture && !model.supportsTexture || pbr && !model.supportsPbr) throw new Model3DGenerationError("The selected 3D model does not support these texture options", 400);
    return this.session(signal, async (key, requestSignal) => {
      let endpoint: string, body: Record<string, unknown>;
      if (operation === "retexture" || operation === "remesh") {
        if (!input.source?.length) throw new Model3DGenerationError("Choose a source GLB", 400);
        const source = await this.upload(input.source, "model/gltf-binary", "model.glb", key, requestSignal, input.execution, "source-upload");
        if (operation === "remesh") {
          endpoint = "mesh/decimate"; body = { input: source, model: "v3.0", face_limit: faces, quad: false, bake: true };
        } else {
          if (input.images.length > 1 || input.images.length && input.prompt?.trim()) throw new Model3DGenerationError("Choose one texture image or a prompt", 400);
          const version = input.options?.textureModel ?? "v3.5-20260815";
          if (!["v3.5-20260815", "v3.0-20250812", "v2.5-20250123"].includes(version)) throw new Model3DGenerationError("Unsupported Tripo texture version", 400);
          const image = input.images[0];
          const token = image ? await this.imageUpload(image, key, requestSignal, input.execution, "texture-upload") : undefined;
          endpoint = "models/texture"; body = { input: source, model: version, pbr: input.pbr ?? false,
            texture_prompt: token ? { image: token } : { text: input.prompt }, texture_quality: input.options?.textureQuality ?? "standard" };
        }
      } else {
        const tokens: string[] = [];
        for (const [index, image] of input.images.entries()) tokens.push(await this.imageUpload(image, key, requestSignal, input.execution, `image-upload-${index}`));
        endpoint = `generation/${operation === "text" ? "text-to-model" : tokens.length === 1 ? "image-to-model" : "multiview-to-model"}`;
        body = { model: input.model.id, face_limit: faces, texture, pbr,
          ...(operation === "text" ? { prompt: input.prompt } : tokens.length === 1 ? { input: tokens[0] } : { inputs: tokens.map((token, index) => ({ [VIEW_NAMES[index]!]: token })) }) };
      }
      const { taskId, task } = await this.task(endpoint, body, key, requestSignal, input.execution, "generate");
      return { bytes: await this.download(task, requestSignal), mediaType: "model/gltf-binary", requestId: taskId,
        ...(operation === "image" || operation === "text" ? { metadata: { forwardAxis: "+X" as const } } : {}) };
    });
  }

  async animations(_signal?: AbortSignal, _model?: unknown, options?: Model3DOptions) {
    if (options?.rigModel && !["v1.0-20240301", "v2.5-20260210"].includes(options.rigModel)
      || options?.rigType && !["biped", "quadruped", "hexapod", "octopod", "serpentine", "aquatic"].includes(options.rigType)
      || options?.rigModel !== "v2.5-20260210" && options?.rigType && options.rigType !== "biped") throw new Model3DGenerationError("Unsupported Tripo rig version or type", 400);
    return tripoActions(options?.rigModel, options?.rigType);
  }

  async animate(input: Model3DAnimationInput, signal?: AbortSignal): Promise<Generated3DModel> {
    const rigModel = input.options?.rigModel ?? "v1.0-20240301", rigType = input.options?.rigType ?? "biped";
    if (rigModel === "v1.0-20240301" && rigType !== "biped") throw new Model3DGenerationError("Tripo rig v1 supports humanoids only", 400);
    const available = new Set(tripoActions(rigModel, rigType).map((action) => action.id));
    if (!input.actionIds.length || input.actionIds.length > MAX_ANIMATION_ACTIONS || input.actionIds.some((action) => typeof action !== "string" || !available.has(action))) throw new Model3DGenerationError("Choose actions from the selected Tripo rig's presets", 400);
    return this.session(signal, async (key, requestSignal) => {
      const source = await this.upload(input.model, "model/gltf-binary", "model.glb", key, requestSignal, input.execution, "source-upload");
      const check = await this.task("animations/rig-check", { input: source }, key, requestSignal, input.execution, "rig-check");
      const output = record(check.task.output);
      if (output.riggable !== true || output.rig_type !== rigType) throw new Model3DGenerationError(`Tripo rig check requires ${String(output.rig_type ?? "a riggable model")}; choose the matching rig type`, 400);
      const rig = await this.task("animations/rig", { input: source, model: rigModel, rig_type: rigType, spec: "tripo", out_format: "glb" }, key, requestSignal, input.execution, "rig");
      const result = await this.task("animations/retarget", { input: rig.taskId, animations: input.actionIds, out_format: "glb", bake_animation: true, export_with_geometry: true,
        animate_in_place: input.options?.animateInPlace ?? false }, key, requestSignal, input.execution, "animation");
      return { bytes: await this.download(result.task, requestSignal), mediaType: "model/gltf-binary", requestId: result.taskId };
    });
  }

  async accountBalance(signal?: AbortSignal): Promise<Model3DBalance> {
    return this.session(signal, async (key, requestSignal) => {
      const value = await this.json("account/balance", { signal: requestSignal }, key);
      if (typeof value.balance !== "number") throw new Model3DGenerationError("Tripo returned an invalid balance");
      return { balance: value.balance, ...(typeof value.frozen === "number" ? { frozen: value.frozen } : {}) };
    });
  }

  private async session<T>(signal: AbortSignal | undefined, run: (key: string | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.isEnabled()) throw new Model3DGenerationError("Tripo provider is disabled", 409);
    const key = this.apiKey();
    if (!key && this.connection?.authentication !== "none") throw new Model3DGenerationError("Tripo API key is not configured", 503);
    const timeout = AbortSignal.timeout(60 * 60_000), combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    try { combined.throwIfAborted(); return await run(key, combined); }
    catch (cause) { if (timeout.aborted && !signal?.aborted) throw new Model3DGenerationError("Tripo operation timed out; retry to resume the submitted task", 504); throw cause; }
  }
  private scope(key?: string) { return JSON.stringify([this.connection?.baseUrl ?? BASE_URL, key, this.connection?.headers, this.connection?.authentication]); }
  private async imageUpload(image: Model3DGenerationInput["images"][number], key: string | undefined, signal: AbortSignal, execution: Model3DExecution | undefined, stage: string) {
    const bytes = Buffer.from(image.data, "base64");
    if (!["image/png", "image/jpeg"].includes(image.mediaType) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw new Model3DGenerationError("Tripo references must be PNG or JPEG images up to 20 MB", 400);
    return this.upload(bytes, image.mediaType, image.mediaType === "image/png" ? "reference.png" : "reference.jpg", key, signal, execution, stage);
  }
  private async upload(bytes: Buffer, mediaType: string, name: string, key: string | undefined, signal: AbortSignal, execution: Model3DExecution | undefined, stage: string) {
    const submit = async () => {
      const form = new FormData(); form.set("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
      const uploaded = await this.json("files", { method: "POST", body: form, signal }, key);
      if (typeof uploaded.file_token !== "string" || !uploaded.file_token) throw new Model3DGenerationError("Tripo returned no upload token");
      return { token: uploaded.file_token };
    };
    const result = execution ? await execution.submitted(stage, this.scope(key), { bytes: bytes.toString("base64"), mediaType }, submit) : await submit();
    return result.token;
  }
  private async task(endpoint: string, body: Record<string, unknown>, key: string | undefined, signal: AbortSignal, execution?: Model3DExecution, stage = endpoint) {
    const submit = async () => {
      const value = await this.json(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }, key);
      if (typeof value.task_id !== "string" || !value.task_id) throw new Model3DGenerationError("Tripo returned no task ID");
      return { taskId: value.task_id };
    };
    const { taskId } = execution ? await execution.submitted(stage, this.scope(key), { endpoint, body }, submit) : await submit();
    let failures = 0;
    while (true) {
      signal.throwIfAborted();
      let task: Record<string, unknown>;
      try { task = await this.json(`tasks/${encodeURIComponent(taskId)}`, { signal }, key); failures = 0; }
      catch (cause) { if (!(cause instanceof TripoNetworkError) || ++failures >= 3) throw cause; await delay(this.pollIntervalMs, undefined, { signal }); continue; }
      if (task.status === "success") return { taskId, task };
      if (["failed", "cancelled", "canceled"].includes(String(task.status))) throw new Model3DGenerationError(typeof task.error_message === "string" ? task.error_message : `Tripo task ${task.status}`, 400);
      if (!["queued", "running"].includes(String(task.status))) throw new Model3DGenerationError("Tripo returned an unknown task status");
      await delay(this.pollIntervalMs, undefined, { signal });
    }
  }
  private async download(task: Record<string, unknown>, signal: AbortSignal) {
    const url = record(task.output).model_url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Model3DGenerationError("Tripo completed without a GLB artifact");
    const response = await this.request(url, { signal });
    if (!response.ok) throw new Model3DGenerationError(`Tripo GLB download failed (${response.status})`);
    return readModel3DResult(response);
  }
  private async json(endpoint: string, init: RequestInit, key?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.request(`${(this.connection?.baseUrl ?? BASE_URL).replace(/\/+$/, "")}/${endpoint}`, { ...init,
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]),
      headers: { ...this.connection?.headers, ...(this.connection?.authentication === "none" ? {} : { authorization: `Bearer ${key}` }), ...init.headers } }); }
    catch (cause) { if (init.signal?.aborted) throw init.signal.reason ?? cause; throw new TripoNetworkError(`Could not reach Tripo (${cause instanceof Error ? cause.message : String(cause)})`); }
    const body = record(await response.json().catch(() => undefined));
    if (response.ok && body.code === 0 && body.data && typeof body.data === "object") return record(body.data);
    const message = typeof body.message === "string" ? body.message : "Invalid API response";
    if (response.status === 401 || body.code === 1000 || body.code === 1001) throw new Model3DGenerationError("Tripo API key was rejected", 503);
    if (response.status === 429 || body.code === 2000) throw new Model3DGenerationError("Tripo is temporarily rate limited", 429);
    throw new Model3DGenerationError(`Tripo: ${message}`, response.status >= 500 || response.ok ? 502 : 400);
  }
}
class TripoNetworkError extends Model3DGenerationError { constructor(message: string) { super(message, 502); } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
