import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { MediaProviderKeyStore } from "../src/daemon/media-provider-settings.js";
import { TripoProvider } from "../src/daemon/tripo-provider.js";
import { defaultModel3DSettings, normalizeModelUsages } from "../src/shared/custom-models.js";
import { MODEL_3D_MODELS } from "../src/shared/generation-config.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const model = { provider: "tripo", id: "P1-20260311" };
const image = { mediaType: "image/png" as const, data: Buffer.from("reference").toString("base64") };
const BASE = "https://openapi.tripo3d.ai/v3";
const GLB = "https://files.test/model.glb?signature=example";
function service() {
  let uploads = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === GLB) return new Response(Buffer.from("glb"));
    if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: `file_${++uploads}` } });
    if (init?.method === "POST") return Response.json({ code: 0, data: { task_id: "task_1" } });
    return Response.json({ code: 0, data: { status: "success", output: { model_url: GLB } } });
  });
}
async function temporary() { const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-tripo-")); directories.push(directory); return directory; }
async function appFixture(request: typeof fetch) {
  const directory = await temporary();
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime, model3DFetch: request });
  apps.push(app);
  return { app, directory };
}
async function waitForJob(app: ReturnType<typeof createApp>, id: string) {
  let job;
  await vi.waitFor(async () => {
    job = (await app.inject({ method: "GET", url: "/tool-jobs" })).json().find((job: { id: string }) => job.id === id);
    expect(job.status).not.toBe("running");
  });
  return job! as { status: string; error?: string; model?: object };
}

describe("Tripo V3 generation", () => {
  it.each([1, 2, 4])("uploads %i views, selects the matching endpoint and retrieves GLB without leaking credentials", async (count) => {
    const request = service();
    const result = await new TripoProvider(() => "tripo-test-key", request, 0).generate({ model, images: Array(count).fill(image), targetPolycount: 4_000, texture: true, pbr: true });
    expect(result).toEqual({ bytes: Buffer.from("glb"), mediaType: "model/gltf-binary", requestId: "task_1" });
    expect(request.mock.calls.slice(0, count).every(([url, init]) => String(url) === `${BASE}/files` && init?.body instanceof FormData)).toBe(true);
    const uploaded = (request.mock.calls[0]![1]!.body as FormData).get("file") as Blob;
    expect(uploaded.type).toBe("image/png"); expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(Buffer.from("reference"));
    const [url, init] = request.mock.calls[count]!;
    expect(url).toBe(`${BASE}/generation/${count === 1 ? "image-to-model" : "multiview-to-model"}`);
    expect(init?.headers).toMatchObject({ authorization: "Bearer tripo-test-key" });
    expect(JSON.parse(String(init?.body))).toEqual({ model: model.id, face_limit: 4_000, texture: true, pbr: true,
      ...(count === 1 ? { input: "file_1" } : { inputs: ["front", "left", "back", "right"].slice(0, count).map((view, index) => ({ [view]: `file_${index + 1}` })) }),
    });
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(count + 1);
  });

  it("retries transient polls without submitting another paid generation", async () => {
    const request = service();
    const original = request.getMockImplementation()!;
    let polls = 0;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/tasks/") && ++polls === 1) throw new Error("ECONNRESET");
      return original(url, init);
    });
    await new TripoProvider(() => "key", request, 0).generate({ model, images: [image] });
    expect(polls).toBe(2);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
  });

  it("stops after three consecutive network failures without resubmitting the task", async () => {
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/tasks/")) throw new Error("ECONNRESET");
      return original(url, init);
    });
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow("ECONNRESET");
    expect(request.mock.calls.filter(([url]) => String(url).includes("/tasks/"))).toHaveLength(3);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
  });

  it.each([
    { endpoint: "/files", data: {}, message: "no upload token" },
    { endpoint: "/generation/image-to-model", data: {}, message: "no task ID" },
    { endpoint: "/tasks/task_1", data: { status: "success", output: {} }, message: "without a GLB artifact" },
    { endpoint: "/tasks/task_1", data: { status: "unknown" }, message: "unknown task status" },
  ])("reports malformed responses at $endpoint", async ({ endpoint, data, message }) => {
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => String(url).endsWith(endpoint) ? Response.json({ code: 0, data }) : original(url, init));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow(message);
    expect(request.mock.calls.some(([url]) => String(url) === GLB)).toBe(false);
  });

  it("rejects oversized GLB downloads before reading the body", async () => {
    const request = service(), original = request.getMockImplementation()!;
    const response = new Response("not read", { headers: { "content-length": String(100 * 1024 * 1024 + 1) } });
    const read = vi.spyOn(response, "arrayBuffer");
    request.mockImplementation(async (url, init) => String(url) === GLB ? response : original(url, init));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow("too large");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps texture disabled even when PBR was requested", async () => {
    const request = service();
    await new TripoProvider(() => "key", request, 0).generate({ model, images: [image], texture: false, pbr: true });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ texture: false, pbr: false });
  });

  it("passes custom endpoint headers only to the API and supports no-key authentication", async () => {
    const request = service();
    await new TripoProvider(() => undefined, request, 0, () => true, {
      baseUrl: "https://studio.test/tripo/v3", apiKey: "unused", authentication: "none", headers: { "x-studio": "custom-header" },
      settings: defaultModel3DSettings("standard", "tripo"),
    }).generate({ model: { provider: "studio", id: "studio-alias" }, images: [image] });
    expect(request.mock.calls[0]?.[0]).toBe("https://studio.test/tripo/v3/files");
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ "x-studio": "custom-header" });
    expect(request.mock.calls[1]?.[1]?.headers).not.toHaveProperty("authorization");
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
  });

  it.each([
    { code: 1000, message: "Invalid key" },
    { code: 2010, message: "Insufficient credits" },
  ])("reports API errors including HTTP 200 with nonzero code: $code", async (body) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(body));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow(body.code === 1000 ? "API key was rejected" : "Insufficient credits");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled"])("reports terminal %s tasks", async (status) => {
    const request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => String(url).includes("/tasks/") ? Response.json({ code: 0, data: { status, error_message: "Task could not complete" } }) : original(url, init));
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] })).rejects.toThrow("Task could not complete");
    expect(request.mock.calls.some(([url]) => String(url) === GLB)).toBe(false);
  });

  it("honours cancellation during polling and stops before downloading", async () => {
    const controller = new AbortController(), request = service(), original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).includes("/tasks/")) { controller.abort(); return Response.json({ code: 0, data: { status: "running" } }); }
      return original(url, init);
    });
    await expect(new TripoProvider(() => "key", request, 0).generate({ model, images: [image] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request.mock.calls.some(([url]) => String(url) === GLB)).toBe(false);
  });

  it("rejects unsupported versions, too many views and oversized references before upload", async () => {
    const request = service(), provider = new TripoProvider(() => "key", request, 0);
    await expect(provider.generate({ model: { ...model, id: "unknown" }, images: [image] })).rejects.toThrow("unavailable");
    await expect(provider.generate({ model: { provider: "meshy", id: "meshy-t2" }, images: [image] })).rejects.toThrow("unavailable");
    await expect(provider.generate({ model, images: Array(5).fill(image) })).rejects.toThrow("1 to 4");
    await expect(provider.generate({ model, images: [{ ...image, data: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") }] })).rejects.toThrow("20 MB");
    await expect(provider.generate({ model, images: [image], targetPolycount: 50_000 })).rejects.toThrow("100 and 20000");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Tripo connection and custom models", () => {
  it("persists keys securely, exposes only configured models, honours defaults and fails disabled selections", async () => {
    const request = service(), { app, directory } = await appFixture(request);
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id: "tripo", capabilities: ["3d"], configured: false }));
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual([]);
    const saved = await app.inject({ method: "PUT", url: "/settings/models/providers/tripo", payload: { apiKey: "  tripo-key  " } });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.body).not.toContain("tripo-key");
    expect((await stat(path.join(directory, "tripo.json"))).mode & 0o777).toBe(0o600);
    const restored = new MediaProviderKeyStore(directory, "tripo", "Tripo"); await restored.load(); expect(restored.key()).toBe("tripo-key");
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual(MODEL_3D_MODELS.filter((model) => model.provider === "tripo"));
    expect((await app.inject({ method: "PUT", url: "/model3d-models/default", payload: model })).statusCode).toBe(204);
    const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image] } });
    expect(await waitForJob(app, result.json().id)).toMatchObject({ status: "succeeded", model });
    await app.inject({ method: "PATCH", url: "/settings/models/providers/tripo/enabled", payload: { enabled: false } });
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual([]);
    const disabled = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image], model } });
    expect((await waitForJob(app, disabled.json().id)).status).toBe("failed");
    expect(request.mock.calls.filter(([url]) => String(url).includes("/generation/"))).toHaveLength(1);
    await app.inject({ method: "DELETE", url: "/settings/models/providers/tripo" });
    expect((await app.inject({ method: "GET", url: "/settings/models/providers/tripo" })).json()).toEqual({ configured: false });
    await expect(readFile(path.join(directory, "tripo.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await app.inject({ method: "PATCH", url: "/settings/models/providers/tripo/enabled", payload: { enabled: true } });
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models).toEqual([]);
  });

  it("accepts V3.1 face counts above Meshy's limit through the tool API", async () => {
    const request = service(), { app } = await appFixture(request);
    await app.inject({ method: "PUT", url: "/settings/models/providers/tripo", payload: { apiKey: "tripo-key" } });
    const ref = { provider: "tripo", id: "v3.1-20260211" };
    const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image], model: ref, targetPolycount: 1_200_000 } });
    expect(result.statusCode, result.body).toBe(202);
    expect(await waitForJob(app, result.json().id)).toMatchObject({ status: "succeeded", model: ref });
    const generation = request.mock.calls.find(([url]) => String(url).includes("/generation/"))!;
    expect(JSON.parse(String(generation[1]?.body))).toMatchObject({ model: ref.id, face_limit: 1_200_000 });
  });

  it("generates an arbitrary Tripo alias through a custom no-key endpoint", async () => {
    const request = service(), { app, directory } = await appFixture(request);
    const config = { ...defaultModel3DSettings("standard", "tripo"), baseUrl: "https://studio.test/tripo/v3" };
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { name: "Local Tripo", preset: "tripo", baseUrl: "https://studio.test/v3", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2,
      models: [{ id: "studio-mesh-alias", name: "Studio mesh", reasoning: false, supportsImages: false, contextWindow: 32_000, maxTokens: 4_000, usages: { "3d": config } }],
    } });
    expect(saved.statusCode, saved.body).toBe(201);
    const ref = { provider: saved.json().id, id: "studio-mesh-alias" };
    const result = await app.inject({ method: "POST", url: "/tools/image-to-3d/jobs", payload: { images: [image, image], model: ref } });
    expect(await waitForJob(app, result.json().id)).toMatchObject({ status: "succeeded", model: ref });
    expect(request.mock.calls[0]?.[0]).toBe("https://studio.test/tripo/v3/files");
    const generation = request.mock.calls.find(([url]) => String(url).includes("/generation/"))!;
    expect(JSON.parse(String(generation[1]?.body)).model).toBe("studio-mesh-alias");
    expect(generation[1]?.headers).not.toHaveProperty("authorization");
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("headers");
    expect(await readFile(path.join(directory, "model-visibility.json"), "utf8")).toContain('"protocol": "tripo"');
    expect((await app.inject({ method: "GET", url: "/model3d-models/catalog" })).json().models[0].referenceImageLabels).toEqual(["Front", "Left", "Back", "Right"]);
    expect(() => normalizeModelUsages({ "3d": { ...config, modelType: "smart-topology" } })).toThrow("Smart topology is only supported by Meshy");
  });
});
