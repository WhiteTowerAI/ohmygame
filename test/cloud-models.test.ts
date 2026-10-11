import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { CloudModelsClient } from "../src/daemon/cloud-models.js";
import { BUILTIN_CLOUD_CATALOG, HYPER3D_CONNECTION_ID, HYPER3D_DEFAULT_TIER, type CloudQuotaSnapshot } from "../src/shared/cloud-models.js";
import { accountCloudState, canAffordCloudModel, cloudQuotaSummary, quotaResetTime, CloudQuotaDetails, CloudQuotaStatus } from "../src/renderer/cloud-quota.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { createAgentTools } from "../src/daemon/agent-tools.js";

const MODEL = { provider: HYPER3D_CONNECTION_ID, id: HYPER3D_DEFAULT_TIER };
const CLOUD_MODEL_IDS = BUILTIN_CLOUD_CATALOG.models.map((model) => model.id);
const generation = { model: MODEL, images: [{ mediaType: "image/png" as const, data: "aW1hZ2U=" }] };
function quotas(userId = "user-1", remaining = 5): CloudQuotaSnapshot {
  const balance = { limit: 5, used: 5 - remaining, reserved: 0, remaining, resetsAt: "2026-10-11T16:00:00.000Z" };
  return { userId, fetchedAt: new Date().toISOString(), quotas: [{ key: "hyper3d-models", provider: HYPER3D_CONNECTION_ID, capability: "3d", unit: "models",
    availability: remaining === 0 ? "personal_exhausted" : "ready", personal: balance }] };
}
function remote(remaining = 5) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const route = new URL(String(url)).pathname;
    const authorization = (init?.headers as Record<string, string>).authorization;
    expect(new URL(String(url)).origin).toBe("https://cloud.example");
    expect(init?.redirect).toBe("error");
    const userId = authorization?.endsWith("token-2") ? "user-2" : "user-1";
    if (route === "/v1/cloud/catalog") return Response.json(BUILTIN_CLOUD_CATALOG);
    if (route === "/v1/me/quotas") return Response.json(quotas(userId, remaining));
    if (route === "/v1/cloud/3d/jobs") return Response.json({ id: "job-1", provider: HYPER3D_CONNECTION_ID, modelId: MODEL.id, status: "running", pollAfterMs: 1 });
    if (route === "/v1/cloud/jobs/job-1") return Response.json({ id: "job-1", provider: HYPER3D_CONNECTION_ID, modelId: MODEL.id, status: "succeeded", pollAfterMs: 5000 });
    if (route === "/v1/cloud/jobs/job-1/result") return new Response("GLB-result");
    if (route === "/v1/cloud/jobs") return Response.json([]);
    throw new Error(`Unexpected route ${route}`);
  });
}
const directories: string[] = [], apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(cloudFetch = remote()) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-free-cloud-")); directories.push(directory);
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, cloudApiUrl: "https://cloud.example", cloudFetch, accessToken: "daemon-token", createModelRuntime: async () => runtime }); apps.push(app);
  const request = (url: string, method: "GET" | "PUT" | "PATCH" = "GET", body?: unknown) => app.inject({ method, url,
    headers: { authorization: "Bearer daemon-token", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { app, directory, cloudFetch, request };
}
describe("desktop free cloud connection", () => {
  it("keeps account and API-key models together, and gates both with a persistent Hyper3D switch", async () => {
    const { app, request, cloudFetch, directory } = await fixture();
    const enabledUrl = "/settings/models/providers/hyper3d/enabled";
    // The brand switch is available before either connection is configured.
    expect((await request(enabledUrl, "PATCH", { enabled: false })).statusCode).toBe(200);
    await request("/cloud/session", "PUT", { accessToken: "account-token-1", userId: "user-1" });
    await request("/settings/models/providers/hyper3d", "PUT", { apiKey: "own-hyper3d-key" });
    expect((await request("/model3d-models/catalog")).json().models).toEqual([]);
    await request(enabledUrl, "PATCH", { enabled: true });
    const models = (await request("/model3d-models/catalog")).json().models;
    expect(models).toContainEqual(expect.objectContaining({ ...MODEL, providerName: "Hyper3D · Free" }));
    expect(models).toContainEqual(expect.objectContaining({ provider: "hyper3d", id: "Gen-2.5-Medium", providerName: "Hyper3D · API key" }));
    // A visibility change belongs only to the selected allowance source.
    await request(`/settings/models/providers/${MODEL.provider}/models/visibility`, "PUT", { ids: CLOUD_MODEL_IDS, visible: false });
    expect((await request("/model3d-models/catalog")).json().models.every((model: { provider: string }) => model.provider === "hyper3d")).toBe(true);
    await request(`/settings/models/providers/${MODEL.provider}/models/visibility`, "PUT", { ids: CLOUD_MODEL_IDS, visible: true });
    await request(`/settings/models/providers/${MODEL.provider}/enabled`, "PATCH", { enabled: false });
    expect((await request("/settings/providers")).json().filter((provider: { id: string }) => ["hyper3d", MODEL.provider].includes(provider.id)).every((provider: { enabled: boolean }) => !provider.enabled)).toBe(true);
    cloudFetch.mockClear();
    const blocked = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", headers: { authorization: "Bearer daemon-token" }, payload: generation });
    expect(blocked.statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect((await request("/tool-jobs")).json().find((job: { id: string }) => job.id === blocked.json().id)).toMatchObject({ status: "failed" });
    });
    expect(cloudFetch).not.toHaveBeenCalled();
    const preferences = JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8"));
    expect(preferences.disabled).toEqual(expect.arrayContaining(["hyper3d", MODEL.provider]));
    // Removing the key neither signs out nor re-enables the brand.
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/hyper3d", headers: { authorization: "Bearer daemon-token" } })).statusCode).toBe(204);
    expect((await request("/model3d-models/catalog")).json().models).toEqual([]);
    await request(enabledUrl, "PATCH", { enabled: true });
    expect((await request("/model3d-models/catalog")).json().models).toHaveLength(10);
    expect((await request("/model3d-models/catalog")).json().models).toContainEqual(expect.objectContaining(MODEL));
  });
  it("shows the cloud's disabled-provider explanation in the account's connection", async () => {
    const base = remote();
    const message = "Hyper3D free generation has not been enabled yet.";
    const client = new CloudModelsClient("https://cloud.example", async (url, init) => {
      if (String(url).endsWith("/quotas")) {
        const snapshot = quotas();
        const quota = snapshot.quotas[0]!;
        return Response.json({ ...snapshot, quotas: [{ ...quota, availability: "unavailable", message,
          personal: { ...quota.personal, limit: null, remaining: null } }] });
      }
      return base(url, init);
    });
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    const connection = client.connection(MODEL.provider);
    expect(connection).toMatchObject({ availability: "unavailable", message });
    expect(cloudQuotaSummary(connection)).toBe(message);
    expect((await client.catalog()).models).toEqual([]);
  });

  it("reuses a verified allowance for unchanged auth heartbeats but refreshes it explicitly", async () => {
    const request = remote();
    const client = new CloudModelsClient("https://cloud.example", request);
    const session = { accessToken: "account-token-1", userId: "user-1" };
    await client.setSession(session);
    expect(request).toHaveBeenCalledTimes(2);
    await client.setSession(session);
    expect(request).toHaveBeenCalledTimes(2);
    await client.quotas();
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("waits for the server's next status check rather than polling through its backoff", async () => {
    const base = remote();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/3d/jobs")) return Response.json({ id: "job-1", provider: MODEL.provider, modelId: MODEL.id, status: "running", pollAfterMs: 120_000 });
      return base(url, init);
    });
    const wait = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => {});
    const client = new CloudModelsClient("https://cloud.example", request, wait);
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    await expect(client.generate(generation)).resolves.toMatchObject({ requestId: "job-1" });
    expect(wait.mock.calls[0]?.[0]).toBe(120_000);
  });
  it("routes manual and agent generation through the same account-metered connection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-cloud-agent-")); directories.push(directory);
    const request = remote();
    const client = new CloudModelsClient("https://cloud.example", request, async () => {});
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    const runner = new ToolRunner(directory, { generate: async () => { throw new Error("Unexpected image generation"); } }, client);
    const projects = new ProjectManager(directory);
    await Promise.all([runner.load(), projects.load()]);
    const project = await projects.create("Cloud test");
    await projects.addGeneratedAsset(project.id, "source.png", Buffer.from("source image"));
    const manual = await runner.run("image-to-3d", generation);
    expect(manual.files[0]!.mediaType).toBe("model/gltf-binary");
    const agent = createAgentTools(project, runner, projects).find((tool) => tool.name === "generate_3d_asset")!;
    const result = await agent.execute("agent-call", { imagePath: "assets/generated/source.png", model: MODEL }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ artifact: { type: "model" } });
    const calls = request.mock.calls.filter(([url]) => String(url).endsWith("/3d/jobs"));
    expect(calls).toHaveLength(2);
    for (const [, init] of calls) expect((init?.headers as Record<string, string>).authorization).toBe("Bearer account-token-1");
  });
  it("lists Hyper3D before login, activates after verification, preserves an exhausted model, and clears tokens on logout", async () => {
    const { app, request, cloudFetch, directory } = await fixture(remote(0));
    expect((await app.inject("/cloud/quotas")).statusCode).toBe(401);
    expect((await request("/settings/providers")).json()).toContainEqual(expect.objectContaining({ id: HYPER3D_CONNECTION_ID, managed: "free_cloud", configured: false, methods: [], cloud: { availability: "sign_in_required" } }));
    expect((await request("/model3d-models/catalog")).json().models).toEqual([]);
    expect(cloudFetch).not.toHaveBeenCalled();
    expect((await request("/cloud/session", "PUT", { accessToken: "account-token-1", userId: "user-1" })).statusCode).toBe(204);
    const catalog = (await request("/model3d-models/catalog")).json();
    expect(catalog.models).toContainEqual(expect.objectContaining(MODEL));
    expect(catalog.providers[0].cloud.availability).toBe("personal_exhausted");
    expect((await request("/model3d-models/default", "PUT", MODEL)).statusCode).toBe(204);
    const modelsPath = `/settings/models/providers/${MODEL.provider}/models`;
    expect((await request(modelsPath)).json()).toMatchObject({ canAddCustomModel: false, models: expect.arrayContaining([expect.objectContaining({ id: MODEL.id, source: "cloud", custom: false, description: expect.stringContaining("0.5 credits") })]) });
    expect((await request(`${modelsPath}/${MODEL.id}`, "PUT", { id: MODEL.id, settings: { tier: "Gen-2.5-High" } })).statusCode).toBe(400);
    expect((await request(`${modelsPath}/visibility`, "PUT", { ids: CLOUD_MODEL_IDS, visible: false })).statusCode).toBe(200);
    expect((await request("/model3d-models/catalog")).json().models).toEqual([]);
    expect((await request(`${modelsPath}/visibility`, "PUT", { ids: CLOUD_MODEL_IDS, visible: true })).statusCode).toBe(200);
    expect((await request(`/settings/models/providers/${MODEL.provider}/enabled`, "PATCH", { enabled: false })).statusCode).toBe(200);
    expect((await request("/model3d-models/catalog")).json()).toMatchObject({ models: [], defaultModel: MODEL });
    await request("/cloud/session", "PUT", null);
    expect((await request("/cloud/quotas")).json()).toBeNull();
    expect((await request("/settings/providers")).json()).toContainEqual(expect.objectContaining({ id: MODEL.provider, enabled: false, configured: false }));
    const contents = await allFiles(directory);
    expect(contents.join("\n")).not.toContain("account-token-1");
  });
  it("checks the returned cloud identity and discards stale responses during an account switch", async () => {
    let finishFirst!: (response: Response) => void;
    const base = remote();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/quotas") && (init?.headers as Record<string, string>).authorization.endsWith("token-1")) return new Promise<Response>((resolve) => { finishFirst = resolve; });
      return base(url, init);
    });
    const client = new CloudModelsClient("https://cloud.example", request);
    const first = client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    await client.setSession({ accessToken: "account-token-2", userId: "user-2" });
    finishFirst(Response.json(quotas("user-1", 0))); await first;
    expect((await client.quotas())?.userId).toBe("user-2");
    await client.setSession({ accessToken: "wrong-token", userId: "forged-user" });
    expect(client.connection(MODEL.provider).availability).toBe("sign_in_required");
    expect((await client.catalog()).models).toEqual([]);
  });
  it("uses only the account token and retries a lost create response with the same idempotency key", async () => {
    let first = true;
    const base = remote();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/3d/jobs") && first) { first = false; throw new TypeError("Network failed"); }
      return base(url, init);
    });
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const client = new CloudModelsClient("https://cloud.example", request, wait);
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    expect(await client.generate(generation)).toMatchObject({ requestId: "job-1", bytes: Buffer.from("GLB-result") });
    const creates = request.mock.calls.filter(([url]) => String(url).endsWith("/3d/jobs"));
    expect(creates).toHaveLength(2);
    expect(creates[0]![1]?.headers).toEqual(creates[1]![1]?.headers);
    expect(JSON.parse(creates[0]![1]!.body as string)).toMatchObject({ provider: MODEL.provider, modelId: MODEL.id });
    expect(creates[0]![1]!.body).not.toContain("account-token");
    expect(wait.mock.calls[0]?.[0]).toBe(5000);
  });
  it("cancels only desktop waiting; it never calls upstream cancellation or refunds", async () => {
    const request = remote();
    const wait = vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); });
    const client = new CloudModelsClient("https://cloud.example", request, wait);
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    const controller = new AbortController();
    const original = wait.getMockImplementation()!;
    wait.mockImplementation(async (ms, signal) => { controller.abort(); await original(ms, signal); });
    await expect(client.generate(generation, controller.signal)).rejects.toThrow();
    expect(request.mock.calls.some(([url]) => /cancel|refund/.test(String(url)))).toBe(false);
    expect(await client.jobs()).toEqual([]);
  });
  it("discards quota responses started before a generation changed the allowance", async () => {
    const base = remote();
    let quotaRequests = 0;
    let finishRefresh!: (response: Response) => void;
    const client = new CloudModelsClient("https://cloud.example", async (url, init) => {
      if (String(url).endsWith("/quotas")) {
        if (++quotaRequests === 2) return new Promise<Response>((resolve) => { finishRefresh = resolve; });
        return Response.json(quotas("user-1", quotaRequests > 2 ? 4 : 5));
      }
      return base(url, init);
    }, async () => {});
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    const refresh = client.quotas();
    await client.generate(generation);
    finishRefresh(Response.json(quotas("user-1", 5)));
    await refresh;
    expect(client.connection(MODEL.provider).quota).toBeUndefined();
    expect((await client.quotas())?.quotas[0]?.personal.remaining).toBe(4);
  });
  it("refreshes quota even when both submission responses are lost", async () => {
    const base = remote();
    let submissions = 0;
    const client = new CloudModelsClient("https://cloud.example", async (url, init) => {
      if (String(url).endsWith("/3d/jobs")) { submissions++; throw new TypeError("Network failed"); }
      if (String(url).endsWith("/quotas")) return Response.json(quotas("user-1", submissions ? 4 : 5));
      return base(url, init);
    });
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    await expect(client.generate(generation)).rejects.toThrow("Network failed");
    expect(submissions).toBe(2);
    expect(client.connection(MODEL.provider).quota).toBeUndefined();
    expect((await client.quotas())?.quotas[0]?.personal.remaining).toBe(4);
  });
  it("keeps a new account's quota when the old account's generation stops", async () => {
    let finishWait!: () => void;
    const client = new CloudModelsClient("https://cloud.example", remote(), async (_ms, signal) => {
      await new Promise<void>((resolve) => { finishWait = resolve; });
      signal.throwIfAborted();
    });
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    const generating = expect(client.generate(generation)).rejects.toThrow();
    await vi.waitFor(() => expect(finishWait).toBeTypeOf("function"));
    await client.setSession({ accessToken: "account-token-2", userId: "user-2" });
    finishWait();
    await generating;
    expect(client.connection(MODEL.provider)).toMatchObject({ userId: "user-2", availability: "ready", quota: { personal: { remaining: 5 } } });
  });
  it("keeps account-token refresh from cancelling generation and rejects unsafe cloud endpoints", async () => {
    const client = new CloudModelsClient("https://cloud.example", remote());
    await client.setSession({ accessToken: "account-token-1", userId: "user-1" });
    const request = remote(); const signals: AbortSignal[] = [];
    const observed = new CloudModelsClient("https://cloud.example", async (url, init) => { signals.push(init!.signal as AbortSignal); return request(url, init); }, async () => {});
    await observed.setSession({ accessToken: "account-token-1", userId: "user-1" });
    await observed.setSession({ accessToken: "renewed-token-1", userId: "user-1" });
    expect(signals[0]!.aborted).toBe(false);
    expect(() => new CloudModelsClient("http://remote.example")).toThrow(/HTTPS/);
    expect(() => new CloudModelsClient("https://username:password@cloud.example")).toThrow();
  });
  it("formats configurable quota units and never invents an unknown balance", () => {
    expect(cloudQuotaSummary({ availability: "sign_in_required" })).toMatch(/Sign in/);
    expect(cloudQuotaSummary({ availability: "unavailable" })).toMatch(/unavailable/);
    const quota = quotas().quotas[0]!;
    expect(cloudQuotaSummary({ availability: "ready", quota: { ...quota, unit: "tokens" } })).toBe("5 / 5 tokens left today");
    expect(cloudQuotaSummary({ availability: "ready", quota: { ...quota, personal: { ...quota.personal, remaining: null } } })).toBe("Quota unavailable");
    expect(cloudQuotaSummary({ availability: "ready", quota: { ...quota, personal: { ...quota.personal, limit: null } } })).toBe("5 models left today");
    expect(quotaResetTime({ ...quota, personal: { ...quota.personal, resetsAt: "2026-10-12T16:00:00.000Z" } }))
      .not.toBe(quotaResetTime(quota));
  });
  it("renders personal-only quota responses in settings and generation with one meter and held credits", () => {
    const quota = { ...quotas().quotas[0]!, unit: "credits" as const,
      personal: { limit: 20, used: 2, reserved: 1, remaining: 17, resetsAt: "2026-10-11T16:00:00.000Z" } };
    const details = renderToStaticMarkup(createElement(CloudQuotaDetails, { quota }));
    expect(details).toContain("Your daily credits");
    expect(details).toContain("17 / 20");
    const status = renderToStaticMarkup(createElement(CloudQuotaStatus, { cloud: { availability: "ready", quota }, estimatedCredits: 0.5, onSignIn: () => {} }));
    expect(status).toContain("17 / 20 credits left today");
    expect(status).toContain("0.5");
    expect(status).toContain("credits / generation");
    for (const html of [details, status]) {
      expect(html.match(/role="meter"/g)).toHaveLength(1);
      expect(html).toContain('aria-valuemax="20"');
      expect(html).toContain('aria-valuenow="17"');
      expect(html).toContain("85%");
      expect(html).toContain(quotaResetTime(quota));
      expect(html).toContain("1 credits held");
      expect(html).not.toContain("Shared");
    }
  });
  it("allows a cheaper tier at 0.5 credits remaining and disables an expensive tier", () => {
    const quota = { ...quotas().quotas[0]!, unit: "credits" as const,
      personal: { limit: 20, used: 19.5, reserved: 0, remaining: 0.5, resetsAt: "2026-10-11T16:00:00.000Z" } };
    const cloud = { availability: "ready" as const, quota };
    expect(canAffordCloudModel(cloud, 0.5)).toBe(true);
    expect(canAffordCloudModel(cloud, 1)).toBe(false);
    expect(canAffordCloudModel({ ...cloud, quota: { ...quota, personal: { ...quota.personal, remaining: 0.5 - Number.EPSILON } } }, 0.5)).toBe(true);
    expect(canAffordCloudModel({ ...cloud, availability: "personal_exhausted" }, 0.5)).toBe(false);
    expect(canAffordCloudModel({ ...cloud, availability: "sign_in_required" }, 0.5)).toBe(false);
    expect(canAffordCloudModel({ availability: "ready" }, 0.5)).toBe(false);
    expect(canAffordCloudModel({ ...cloud, quota: { ...quota, personal: { ...quota.personal, remaining: null } } }, 0.5)).toBe(false);
  });
  it("resolves a saved legacy rodin reference through the live free model catalog", async () => {
    const base = remote();
    const fast = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith("/3d/jobs")
      ? Response.json({ id: "job-1", provider: MODEL.provider, modelId: MODEL.id, status: "succeeded", pollAfterMs: 5000 }) : base(url, init));
    const { app, request, cloudFetch } = await fixture(fast);
    await request("/cloud/session", "PUT", { accessToken: "account-token-1", userId: "user-1" });
    const response = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", headers: { authorization: "Bearer daemon-token" }, payload: { ...generation, model: { ...MODEL, id: "rodin" } } });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(async () => {
      expect((await request("/tool-jobs")).json().find((job: { id: string }) => job.id === response.json().id)).toMatchObject({ status: "succeeded" });
    });
    const submission = cloudFetch.mock.calls.find(([url]) => String(url).endsWith("/3d/jobs"));
    expect(JSON.parse(submission![1]!.body as string).modelId).toBe(HYPER3D_DEFAULT_TIER);
  });
  it("hides another account's cached quota immediately on logout or account switch", () => {
    const cloud = { availability: "ready" as const, userId: "user-1", quota: quotas().quotas[0] };
    expect(accountCloudState(cloud, undefined)).toEqual({ availability: "sign_in_required" });
    expect(accountCloudState(cloud, "user-2")).toEqual({ availability: "unavailable", message: "Checking account quota…" });
    expect(accountCloudState(cloud, "user-1")).toBe(cloud);
  });
});
async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? allFiles(path.join(directory, entry.name)) : readFile(path.join(directory, entry.name), "utf8").then((value) => [value])))).flat();
}
