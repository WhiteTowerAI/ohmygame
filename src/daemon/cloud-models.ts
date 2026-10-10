import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BUILTIN_CLOUD_CATALOG, type Cloud3DRequest, type CloudCatalog, type CloudConnectionState, type CloudGenerationJob, type CloudQuotaSnapshot } from "../shared/cloud-models.js";
import type { MediaModelCatalog, Model3DModel, ProviderSummary } from "../shared/contracts.js";
import { Model3DGenerationError, readModel3DResult, type Model3DGenerationInput, type Model3DGenerator } from "./model3d.js";

/** Product access tokens stay in daemon memory and only go to the configured cloud API. */
export class CloudModelsClient implements Model3DGenerator {
  private session?: { token: string; userId: string; controller: AbortController };
  private metadata: CloudCatalog = BUILTIN_CLOUD_CATALOG;
  private snapshot?: CloudQuotaSnapshot;
  private error?: string;
  private fetchedAt = 0;
  private quotaRevision = 0;
  private refreshPending?: Promise<void>;
  private readonly apiUrl: string;
  constructor(apiUrl: string, private readonly request: typeof fetch = fetch,
    private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<unknown> = (milliseconds, signal) => delay(milliseconds, undefined, { signal })) {
    const url = new URL(apiUrl);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password) throw new Error("Cloud API must use HTTPS (or local development HTTP)");
    this.apiUrl = url.href.replace(/\/$/, "");
  }
  async setSession(input: { accessToken: string; userId: string } | null): Promise<void> {
    if (input && this.session?.userId === input.userId) {
      // An identical auth heartbeat can reuse a recently verified allowance.
      if (this.session.token === input.accessToken) return this.refresh();
      this.session.token = input.accessToken;
      await this.refreshPending;
      return this.refresh(true);
    }
    this.session?.controller.abort();
    this.session = input ? { token: input.accessToken, userId: input.userId, controller: new AbortController() } : undefined;
    this.refreshPending = undefined;
    this.snapshot = undefined;
    this.error = undefined;
    if (input) await this.refresh(true);
  }
  async refresh(force = false): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (!force && this.snapshot && Date.now() - this.fetchedAt < 15_000) return;
    if (this.refreshPending) return this.refreshPending;
    const pending = (async () => {
      const token = session.token;
      const revision = this.quotaRevision;
      try {
        const [metadata, snapshot] = await Promise.all([
          this.json<CloudCatalog>("/v1/cloud/catalog", session), this.json<CloudQuotaSnapshot>("/v1/me/quotas", session),
        ]);
        if (this.session !== session || session.token !== token || this.quotaRevision !== revision) return;
        if (snapshot.userId !== session.userId || !Array.isArray(snapshot.quotas) || !Array.isArray(metadata.providers) || !Array.isArray(metadata.models)) throw new Model3DGenerationError("Could not verify the cloud account", 401);
        this.metadata = metadata;
        this.snapshot = snapshot;
        this.fetchedAt = Date.now();
        this.error = undefined;
      } catch (cause) {
        if (this.session !== session || session.token !== token || this.quotaRevision !== revision) return;
        this.error = cause instanceof Model3DGenerationError ? cause.message : "Free cloud models are temporarily unavailable";
        if (cause instanceof Model3DGenerationError && cause.statusCode === 401) { session.controller.abort(); this.session = undefined; this.snapshot = undefined; }
      }
    })();
    this.refreshPending = pending;
    try { await pending; } finally { if (this.refreshPending === pending) this.refreshPending = undefined; }
  }
  async quotas(): Promise<CloudQuotaSnapshot | null> { await this.refresh(true); return this.snapshot ?? null; }
  async cloudCatalog(): Promise<CloudCatalog> { await this.refresh(); return this.metadata; }
  connection(provider: string): CloudConnectionState {
    const quota = this.snapshot?.quotas.find((quota) => quota.provider === provider);
    return { availability: !this.session ? "sign_in_required" : this.error || !quota ? "unavailable" : quota.availability,
      ...(this.session ? { userId: this.session.userId } : {}),
      ...(quota ? { quota } : {}), ...(this.error ? { message: this.error } : quota?.message ? { message: quota.message } : {}) };
  }
  async providers(isEnabled: (id: string) => boolean): Promise<ProviderSummary[]> {
    await this.refresh();
    return this.metadata.providers.map((provider) => {
      const cloud = this.connection(provider.id), configured = Boolean(this.snapshot?.quotas.some((quota) => quota.provider === provider.id && quota.availability !== "unavailable"));
      return { id: provider.id, name: `${provider.name} · Free`, managed: "free_cloud", configured, cloud, enabled: isEnabled(provider.id),
        status: this.error ? "error" : configured ? "connected" : "not_configured", capabilities: provider.capabilities, methods: [] };
    });
  }
  async catalog(): Promise<MediaModelCatalog<Model3DModel>> {
    await this.refresh();
    const providers = this.metadata.providers.filter((provider) => provider.capabilities.includes("3d")).map((provider) => {
      const cloud = this.connection(provider.id);
      return { provider: provider.id, providerName: `${provider.name} · Free`, cloud, state: cloud.availability === "ready" ? "ready" as const : "empty" as const, message: cloudMessage(cloud) };
    });
    const models = this.metadata.models.filter((model) => model.capability === "3d" && model.polycount && model.maxReferenceImages
      && this.snapshot?.quotas.some((quota) => quota.provider === model.provider && quota.availability !== "unavailable")).map((model) => ({
      ...model, providerName: `${this.metadata.providers.find((provider) => provider.id === model.provider)?.name ?? model.provider} · Free`,
      maxReferenceImages: model.maxReferenceImages!, polycount: model.polycount!,
    }));
    return { models, providers };
  }
  async jobs(): Promise<CloudGenerationJob[]> { return this.json("/v1/cloud/jobs", this.requireSession()); }
  async result(id: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.response(`/v1/cloud/jobs/${encodeURIComponent(id)}/result`, this.requireSession(), { signal });
    return readModel3DResult(response);
  }
  async generate(input: Model3DGenerationInput, signal?: AbortSignal) {
    const session = this.requireSession();
    const combined = AbortSignal.any([session.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(25 * 60_000)]);
    const body: Cloud3DRequest = { provider: input.model.provider, modelId: input.model.id,
      images: input.images.map((image) => ({ mediaType: image.mediaType as "image/png" | "image/jpeg", data: image.data })),
      targetPolycount: input.targetPolycount, texture: input.texture, pbr: input.pbr };
    const requestKey = randomUUID();
    const create = () => this.json<CloudGenerationJob>("/v1/cloud/3d/jobs", session, { method: "POST", signal: combined,
      headers: { "content-type": "application/json", "idempotency-key": requestKey }, body: JSON.stringify(body) });
    try {
      let job: CloudGenerationJob;
      try { job = await create(); }
      catch (cause) {
        // Retry only transport/server failures at our idempotent endpoint, using the same key.
        if (combined.aborted || cause instanceof Model3DGenerationError && cause.statusCode < 500) throw cause;
        job = await create();
      }
      this.invalidateQuotas(session);
      while (job.status === "queued" || job.status === "running") {
        const pollAfter = Number.isFinite(job.pollAfterMs) ? job.pollAfterMs : 5_000;
        await this.wait(Math.max(5_000, Math.min(20 * 60_000, pollAfter)), combined);
        job = await this.json<CloudGenerationJob>(`/v1/cloud/jobs/${encodeURIComponent(job.id)}`, session, { signal: combined });
      }
      if (job.status !== "succeeded") throw new Model3DGenerationError(job.message ?? "Cloud generation could not complete. Its job is retained on your account", 502);
      const response = await this.response(`/v1/cloud/jobs/${encodeURIComponent(job.id)}/result`, session, { signal: combined });
      return { bytes: await readModel3DResult(response), mediaType: "model/gltf-binary" as const, requestId: job.id };
    } finally {
      // Even a lost submission response may have reserved quota on the server.
      this.invalidateQuotas(session);
      // Cancelling desktop waiting does not cancel or refund an accepted cloud job.
    }
  }
  private invalidateQuotas(session: NonNullable<CloudModelsClient["session"]>) {
    if (this.session !== session) return;
    this.quotaRevision++;
    this.snapshot = undefined;
  }
  private requireSession() {
    if (!this.session) throw new Model3DGenerationError("Sign in to use free cloud models", 401);
    return this.session;
  }
  private async response(path: string, session: NonNullable<CloudModelsClient["session"]>, init: RequestInit = {}) {
    const response = await this.request(`${this.apiUrl}${path}`, { ...init, redirect: "error",
      signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(init.method === "POST" ? 90_000 : 70_000), ...(init.signal ? [init.signal] : [])]),
      headers: { ...init.headers, authorization: `Bearer ${session.token}` } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: unknown };
      throw new Model3DGenerationError(typeof body.message === "string" ? body.message : "Free cloud request failed", response.status);
    }
    return response;
  }
  private async json<T>(path: string, session: NonNullable<CloudModelsClient["session"]>, init: RequestInit = {}): Promise<T> { return (await this.response(path, session, init)).json() as Promise<T>; }
}
export function cloudMessage(cloud: CloudConnectionState): string {
  if (cloud.message) return cloud.message;
  return { ready: "Free cloud generation", sign_in_required: "Sign in to use free cloud models", unavailable: "Free cloud generation is temporarily unavailable",
    personal_exhausted: "Your daily free quota is exhausted" }[cloud.availability];
}
