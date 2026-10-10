import { setTimeout as delay } from "node:timers/promises";
import type { CustomModel3DSettings } from "../shared/contracts.js";
import { model3DPreset } from "../shared/model3d-presets.js";
import type { ImageSource } from "./image-adapters.js";
import { Model3DGenerationError, readModel3DResult, type Model3DGenerator, type Model3DGenerationInput } from "./model3d.js";

const API = "https://api.hyper3d.com/api/v2";

/** A user's own Rodin connection; product login and free-cloud quotas do not apply. */
export class Hyper3DProvider implements Model3DGenerator {
  constructor(private readonly apiKey: () => string | undefined, private readonly request: typeof fetch = fetch,
    private readonly pollIntervalMs = 5_000, private readonly isEnabled: () => boolean = () => true,
    private readonly connection?: ImageSource & { settings: CustomModel3DSettings }) {}

  async generate(input: Model3DGenerationInput, signal?: AbortSignal, settings?: CustomModel3DSettings) {
    if (!this.isEnabled()) throw new Model3DGenerationError("Hyper3D provider is disabled", 409);
    const key = this.apiKey();
    if (!key && this.connection?.authentication !== "none") throw new Model3DGenerationError("Hyper3D API key is not configured", 503);
    const model = settings ?? this.connection?.settings ?? model3DPreset(input.model.provider, input.model.id)?.settings;
    if (!model || model.protocol !== "hyper3d") throw new Model3DGenerationError("The selected Hyper3D model is unavailable", 400);
    if (!input.images.length || input.images.length > model.maxReferenceImages) throw new Model3DGenerationError(`Provide 1 to ${model.maxReferenceImages} reference images`, 400);
    const faces = input.targetPolycount ?? model.polycount.default;
    if (!Number.isInteger(faces) || faces < model.polycount.min || faces > model.polycount.max) throw new Model3DGenerationError(`Hyper3D face count must be between ${model.polycount.min} and ${model.polycount.max}`, 400);
    const texture = input.texture ?? model.defaults?.texture ?? model.supportsTexture;
    const pbr = texture && (input.pbr ?? model.defaults?.pbr ?? false);
    if (texture && !model.supportsTexture || pbr && !model.supportsPbr) throw new Model3DGenerationError("The selected model does not support these texture options", 400);
    const form = new FormData(); let size = 0;
    input.images.forEach((image, index) => {
      if (!["image/png", "image/jpeg"].includes(image.mediaType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Model3DGenerationError("Hyper3D references must be PNG or JPEG", 400);
      const bytes = Buffer.from(image.data, "base64"); size += bytes.length;
      if (!bytes.length || size > 20 * 1024 * 1024) throw new Model3DGenerationError("Hyper3D references must total at most 20 MB", 413);
      form.append("images", new Blob([bytes], { type: image.mediaType }), `reference-${index}.${image.mediaType === "image/png" ? "png" : "jpg"}`);
    });
    form.set("tier", input.model.id);
    if (input.model.id.startsWith("Gen-2.5-")) form.set("texture_mode", "medium");
    form.set("geometry_file_format", "glb"); form.set("mesh_mode", "Raw");
    form.set("quality_override", String(faces)); form.set("material", !texture ? "None" : pbr ? "PBR" : "Shaded");
    const timeout = AbortSignal.timeout(25 * 60_000);
    const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    try {
      const submitted = await this.json("rodin", key, { method: "POST", body: form, signal: combined });
      const uuid = submitted.uuid, subscriptionKey = record(submitted.jobs).subscription_key;
      if (typeof uuid !== "string" || !uuid || typeof subscriptionKey !== "string" || !subscriptionKey) throw new Model3DGenerationError("Hyper3D returned no task credentials. Check your provider dashboard before retrying");
      while (true) {
        await delay(this.pollIntervalMs, undefined, { signal: combined });
        let status: Record<string, unknown>;
        try { status = await this.json("status", key, { method: "POST", signal: combined, headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription_key: subscriptionKey }) }); }
        catch (cause) {
          if (cause instanceof Hyper3DThrottled) { await delay(cause.retryAfterMs, undefined, { signal: combined }); continue; }
          throw cause;
        }
        const jobs = Array.isArray(status.jobs) ? status.jobs.map((job) => record(job).status) : [];
        if (!jobs.length || jobs.some((state) => !["Waiting", "Generating", "Done", "Failed"].includes(String(state)))) throw new Model3DGenerationError("Hyper3D returned an invalid task status");
        if (jobs.includes("Failed")) throw new Model3DGenerationError("Hyper3D could not generate this model", 400);
        if (!jobs.every((state) => state === "Done")) continue;
        const downloaded = await this.json("download", key, { method: "POST", signal: combined, headers: { "content-type": "application/json" }, body: JSON.stringify({ task_uuid: uuid }) });
        const file = Array.isArray(downloaded.list) ? downloaded.list.map(record).find((item) => typeof item.name === "string" && item.name.toLowerCase().endsWith(".glb")) : undefined;
        let url: URL;
        try { url = new URL(String(file?.url)); } catch { throw new Model3DGenerationError("Hyper3D completed without a GLB artifact"); }
        if (url.protocol !== "https:" || url.username || url.password) throw new Model3DGenerationError("Hyper3D completed without a valid GLB artifact");
        // Signed download URLs receive no provider credential or custom headers.
        try {
          const response = await this.request(url.href, { signal: combined });
          if (!response.ok) throw new Model3DGenerationError("Hyper3D GLB download failed");
          return { bytes: await readModel3DResult(response), mediaType: "model/gltf-binary" as const, requestId: uuid };
        } catch (cause) {
          if (combined.aborted || cause instanceof Model3DGenerationError) throw cause;
          throw new Model3DGenerationError("Hyper3D GLB download failed");
        }
      }
    } catch (cause) {
      if (timeout.aborted && !signal?.aborted) throw new Model3DGenerationError("Hyper3D generation timed out", 504);
      throw cause;
    }
  }
  private async json(endpoint: string, key: string | undefined, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.request(`${(this.connection?.baseUrl ?? API).replace(/\/+$/, "")}/${endpoint}`, { ...init, redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]),
      headers: { ...this.connection?.headers, ...(this.connection?.authentication === "none" ? {} : { authorization: `Bearer ${key}` }), ...init.headers } }); }
    catch (cause) {
      if (init.signal?.aborted) throw cause;
      throw new Model3DGenerationError(endpoint === "rodin" ? "Hyper3D submission could not be confirmed. Check your provider dashboard before retrying" : "Could not reach Hyper3D");
    }
    const body = record(await response.json().catch(() => undefined));
    if (response.ok && !body.error) return body;
    if (response.status === 401 || response.status === 403) throw new Model3DGenerationError("Hyper3D API key was rejected", 503);
    if (response.status === 429 || body.error === "API_PARALLELISM_LIMIT_REACHED") {
      const retry = response.headers.get("retry-after");
      const ms = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1_000 : Date.parse(retry) - Date.now()) : 5_000;
      throw new Hyper3DThrottled(Number.isFinite(ms) ? Math.max(5_000, Math.min(300_000, ms)) : 5_000);
    }
    const messages: Record<string, string> = { API_INSUFFICIENT_FUNDS: "Your Hyper3D credits are insufficient", API_OBJECT_NOT_FOUND_ON_IMAGE: "No supported object was found in the reference image", IMAGE_CONTENT_VIOLATION: "Hyper3D could not accept the reference image" };
    throw new Model3DGenerationError(messages[String(body.error)] ?? "Hyper3D could not accept this request", response.status >= 500 ? 502 : 400);
  }
}
class Hyper3DThrottled extends Model3DGenerationError {
  constructor(readonly retryAfterMs: number) { super("Hyper3D is temporarily rate limited", 429); }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
