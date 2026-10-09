import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { defaultImageSettings, defaultModel3DSettings, defaultVideoSettings } from "../src/shared/custom-models.js";
import type { CustomProviderModel, SaveCustomProviderRequest, ToolId } from "../src/shared/contracts.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const connection = { name: "My studio", baseUrl: "https://studio.test/v1", api: "openai-completions", authentication: "api_key" as const, apiKey: "studio-test-key" };
const reference = { mediaType: "image/png", data: Buffer.from("reference").toString("base64") };
const model = (id: string, usages: CustomProviderModel["usages"]): CustomProviderModel => ({
  id, name: id, api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false, usages,
});
async function fixture(request: typeof fetch = vi.fn(async () => Response.json({ data: [] }))) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-custom-media-"));
  directories.push(directory);
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime,
    imageFetch: request, videoFetch: request, model3DFetch: request, modelDiscoveryFetch: request });
  apps.push(app);
  const save = async (models: CustomProviderModel[], overrides: Partial<SaveCustomProviderRequest> = {}) => {
    const result = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, modelConfigurationVersion: 2, models, ...overrides } });
    expect(result.statusCode, result.body).toBe(201);
    return result.json() as { id: string };
  };
  return { app, runtime, directory, save };
}
async function generate(app: ReturnType<typeof createApp>, tool: ToolId, payload: Record<string, unknown>) {
  const result = await app.inject({ method: "POST", url: `/tools/${tool}/jobs`, payload });
  expect(result.statusCode, result.body).toBe(202);
  await vi.waitFor(async () => {
    const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
    const job = jobs.find((job: { id: string }) => job.id === result.json().id);
    expect(job?.status, job?.error).toBe("succeeded");
  });
}

describe("unified custom media models", () => {
  it("persists every use, exposes only language models to the SDK, and honours visibility and defaults after restart", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("No model discovery should be needed"); });
    const { app, runtime, directory, save } = await fixture(request);
    const { id } = await save([
      model("same-model", { language: true, image: defaultImageSettings() }),
      model("my-video-alias", { video: defaultVideoSettings() }),
      model("my-mesh-alias", { "3d": defaultModel3DSettings() }),
      model("unassigned", {}),
    ], { hiddenModelIds: ["unassigned"] });
    expect(runtime.getModels(id).map((model) => model.id)).toEqual(["same-model"]);
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id, capabilities: ["language", "image", "video", "3d"] }));
    const details = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/models` })).json();
    expect(details.models.map((model: { id: string }) => model.id)).toEqual(["same-model", "my-video-alias", "my-mesh-alias", "unassigned"]);
    for (const [endpoint, modelId] of [["image", "same-model"], ["video", "my-video-alias"], ["model3d", "my-mesh-alias"]]) {
      const catalog = (await app.inject({ method: "GET", url: `/${endpoint}-models/catalog` })).json();
      expect(catalog.models).toContainEqual(expect.objectContaining({ provider: id, id: modelId }));
      expect((await app.inject({ method: "PUT", url: `/${endpoint}-models/default`, payload: { provider: id, id: modelId } })).statusCode).toBe(204);
    }
    const restored = new ProviderModelSettingsStore(directory, directory);
    await restored.load();
    expect((await restored.customProvider(id))?.models).toHaveLength(4);
    expect(restored.defaultImageModel()).toEqual({ provider: id, id: "same-model" });
    expect(restored.defaultVideoModel()).toEqual({ provider: id, id: "my-video-alias" });
    expect(restored.defaultModel3D()).toEqual({ provider: id, id: "my-mesh-alias" });
    expect((await app.inject({ method: "DELETE", url: "/video-models/default" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/video-models/catalog" })).json()).not.toHaveProperty("defaultModel");
    expect((await app.inject({ method: "PUT", url: "/video-models/default", payload: { provider: id, id: "my-video-alias" } })).statusCode).toBe(204);
    expect(await readFile(path.join(directory, "model-visibility.json"), "utf8")).not.toContain(connection.apiKey);
    const hidden = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/models/visibility`, payload: { ids: ["same-model", "my-video-alias", "my-mesh-alias"], visible: false } });
    expect(hidden.statusCode, hidden.body).toBe(200);
    for (const endpoint of ["image", "video", "model3d"]) expect((await app.inject({ method: "GET", url: `/${endpoint}-models/catalog` })).json().models).toEqual([]);
    expect((await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/models/visibility`, payload: { ids: ["unassigned"], visible: true } })).statusCode).toBe(400);
    expect(request).not.toHaveBeenCalled();
    await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}/custom` });
    const removed = new ProviderModelSettingsStore(directory, directory);
    await removed.load();
    expect(removed.defaultImageModel()).toBeUndefined(); expect(removed.defaultVideoModel()).toBeUndefined(); expect(removed.defaultModel3D()).toBeUndefined();
  });

  it.each(["openai-images", "gemini-generate-content", "openrouter-images", "volcengine-images"] as const)("generates an arbitrary image alias with %s and its address override", async (protocol) => {
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("image").toString("base64") } }] } }] });
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] });
    });
    const { app, save } = await fixture(request);
    const { id } = await save([model("totally-custom-image", { image: { ...defaultImageSettings(protocol), baseUrl: "https://images.test/v1" } })]);
    await generate(app, "generate-image", { prompt: "A game icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: id, id: "totally-custom-image" } });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(protocol === "gemini-generate-content" ? "https://images.test/v1beta/models/totally-custom-image:generateContent" : protocol === "openrouter-images" ? "https://images.test/v1/images" : "https://images.test/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${connection.apiKey}` });
    if (protocol !== "gemini-generate-content") expect(JSON.parse(String(init?.body)).model).toBe("totally-custom-image");
    expect(request.mock.calls.some(([url]) => String(url).endsWith("/models"))).toBe(false);
  });

  it.each(["openrouter-videos", "seedance"] as const)("creates, polls and downloads a custom video alias with %s", async (protocol) => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === "https://files.test/output.mp4") return new Response(Buffer.from("video"));
      if (init?.method === "POST") return Response.json({ id: "video-job" });
      return protocol === "seedance" ? Response.json({ status: "succeeded", content: { video_url: "https://files.test/output.mp4" } })
        : Response.json({ status: "completed", unsigned_urls: ["https://files.test/output.mp4"] });
    });
    const { app, save } = await fixture(request);
    const { id } = await save([model("custom-video", { video: { ...defaultVideoSettings(protocol), baseUrl: "https://videos.test/api" } })]);
    await generate(app, "generate-video", { prompt: "A game trailer", duration: 6, resolution: "720p", aspectRatio: "16:9", model: { provider: id, id: "custom-video" } });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual(protocol === "seedance"
      ? ["https://videos.test/api/contents/generations/tasks", "https://videos.test/api/contents/generations/tasks/video-job", "https://files.test/output.mp4"]
      : ["https://videos.test/api/videos", "https://videos.test/api/videos/video-job", "https://files.test/output.mp4"]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).model).toBe("custom-video");
  });

  it.each(["image-to-3d", "multi-image-to-3d"] as const)("runs a custom Meshy alias through %s with its configured polycount", async (operation) => {
    const request = vi.fn<typeof fetch>(async (url, init) => String(url) === "https://files.test/model.glb" ? new Response(Buffer.from("glb"))
      : init?.method === "POST" ? Response.json({ result: "mesh-job" }) : Response.json({ status: "SUCCEEDED", model_urls: { glb: "https://files.test/model.glb" } }));
    const { app, save } = await fixture(request);
    const config = { ...defaultModel3DSettings(), operation, maxReferenceImages: operation === "multi-image-to-3d" ? 4 : 1, baseUrl: "https://meshes.test/openapi/v1" };
    const { id } = await save([model("my-mesh-v5", { "3d": config })]);
    await generate(app, "image-to-3d", { images: operation === "multi-image-to-3d" ? [reference, reference] : [reference], targetPolycount: 100_000, model: { provider: id, id: "my-mesh-v5" } });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([`https://meshes.test/openapi/v1/${operation}`, `https://meshes.test/openapi/v1/${operation}/mesh-job`, "https://files.test/model.glb"]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ ai_model: "my-mesh-v5", target_polycount: 100_000, should_remesh: true });
  });

  it("supports native Google authentication and no-key local image services", async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url).includes(":generateContent")
      ? Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("image").toString("base64") } }] } }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const { app, save } = await fixture(request);
    const google = await save([model("native-image", { image: defaultImageSettings("gemini-generate-content") })], { preset: "google", api: "google-generative-ai" });
    await generate(app, "generate-image", { prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: google.id, id: "native-image" } });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-goog-api-key": connection.apiKey });
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
    const local = await save([model("local-image", { image: defaultImageSettings() })], { name: "Local image service", authentication: "none", apiKey: undefined });
    await generate(app, "generate-image", { prompt: "Icon", resolution: "1K", aspectRatio: "1:1", imageModel: { provider: local.id, id: "local-image" } });
    expect(request.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("retains unassigned and disabled models and never discovers or enables images behind the user's choices", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-image-1" }, { id: "unknown" }] }));
    const { app, save } = await fixture(request);
    const discovered = (await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: connection })).json();
    expect(discovered.models.map((model: { id: string }) => model.id)).toEqual(["gpt-image-1", "unknown"]);
    expect(discovered.models[1].usages).toEqual({});
    const { id } = await save(discovered.models, { hiddenModelIds: ["gpt-image-1", "unknown"] });
    request.mockClear();
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json().models).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
    const invalid = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, models: [model("unknown", {})] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain("Assign a use");
  });

  it("imports legacy image access once and preserves the user's subsequent edits", async () => {
    const request = vi.fn<typeof fetch>(async (url) => String(url) === `${connection.baseUrl}/models` ? Response.json({ data: [{ id: "gpt-image-1" }] }) : Response.json({ data: [] }));
    const { app, directory } = await fixture(request);
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, models: [{ ...model("chat", undefined) }] } });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toContainEqual(expect.objectContaining({ provider: id, id: "gpt-image-1" }));
    const store = new ProviderModelSettingsStore(directory, directory);
    await store.load();
    const settings = (await store.customProvider(id))!;
    expect(settings.modelConfigurationVersion).toBe(2);
    expect(settings.models.map((model) => model.id)).toEqual(["chat", "gpt-image-1"]);
    const updated = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...settings, hiddenModelIds: ["gpt-image-1"], models: settings.models.map((model) => model.id === "gpt-image-1" ? { ...model, name: "My image", usages: { image: { ...defaultImageSettings(), maxReferenceImages: 0 } } } : model) } });
    expect(updated.statusCode, updated.body).toBe(200);
    request.mockClear();
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("retains an existing language use when migrating a multimodal image model", async () => {
    const modelId = "gemini-3.1-flash-image";
    const request = vi.fn<typeof fetch>(async (url) => String(url) === `${connection.baseUrl}/models` ? Response.json({ data: [{ id: modelId }] }) : Response.json({ data: [] }));
    const { app, runtime } = await fixture(request);
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...connection, models: [{ ...model(modelId, undefined), name: "My existing model", supportsImages: true }] } });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    expect((await app.inject({ method: "GET", url: "/image-models/catalog" })).json().models).toContainEqual(expect.objectContaining({ provider: id, id: modelId }));
    const migrated = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json();
    expect(migrated.models).toHaveLength(1);
    expect(migrated.models[0]).toMatchObject({ id: modelId, name: "My existing model", usages: { language: true, image: { protocol: "gemini-generate-content" } } });
    expect(runtime.getModels(id).map((model) => model.id)).toEqual([modelId]);
  });
});
