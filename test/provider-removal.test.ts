import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const model = { id: "custom/test", name: "Custom test", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false };
const otherCredential = { type: "api_key", key: "other-test-key" };

async function fixture(files: Record<string, unknown> = {}) {
  vi.stubEnv("OPENAI_API_KEY", "");
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-provider-removal-"));
  directories.push(directory);
  for (const [file, contents] of Object.entries(files)) await writeFile(path.join(directory, file), typeof contents === "string" ? contents : JSON.stringify(contents));
  const restart = async () => {
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    await app.ready();
    return { runtime, app };
  };
  return { directory, restart, ...await restart() };
}

async function preferences(directory: string) {
  const store = new ProviderModelSettingsStore(directory, directory);
  await store.load();
  return store;
}

async function connect(runtime: ModelRuntime, providerId: string) {
  await runtime.login(providerId, "api_key", { signal: new AbortController().signal, notify: () => {}, prompt: async () => "replacement-test-key" });
}

describe("provider deletion", () => {
  it("clears an official API-key connection and its settings, retaining other providers and allowing reconnection", async () => {
    const { app, runtime, directory, restart } = await fixture({
      "auth.json": { openai: { type: "api_key", key: "openai-test-key" }, anthropic: otherCredential },
      "models.json": '{\n // Keep unrelated JSONC\n "providers": { "openai": { "baseUrl": "https://relay.example/v1", "models": [{ "id": "custom/test", "name": "Custom test" }] }, "anthropic": { "modelOverrides": { "claude-sonnet-4-5": { "name": "My Claude" } } } }\n}',
      "openai-endpoint.json": { version: 1, baseUrl: "https://relay.example/v1" },
      "model-visibility.json": { version: 1, hidden: { openai: [model.id], anthropic: ["claude-sonnet-4-5"] }, disabled: ["openai", "anthropic"], defaultImageModel: { provider: "openai", id: "gpt-image-1" }, defaultVideoModel: { provider: "other", id: "keep-video" } },
    });
    expect(runtime.getModel("openai", model.id)).toBeDefined();
    const removed = await app.inject({ method: "DELETE", url: "/settings/models/providers/openai" });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(runtime.hasConfiguredAuth("openai")).toBe(false);
    expect(await runtime.listCredentials()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
    expect(runtime.getModel("openai", model.id)).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id: "openai", configured: false, enabled: true }));
    expect((await app.inject({ method: "GET", url: "/settings/models/providers/openai/endpoint" })).json()).toEqual({ baseUrl: "https://api.openai.com/v1" });
    const contents = await readFile(path.join(directory, "models.json"), "utf8");
    expect(contents).toContain("// Keep unrelated JSONC");
    expect(contents).not.toContain('"openai"');
    expect(contents).toContain("My Claude");
    const saved = await preferences(directory);
    expect(saved.defaultImageModel()).toBeUndefined();
    expect(saved.defaultVideoModel()).toEqual({ provider: "other", id: "keep-video" });
    expect(saved.isVisible({ provider: "openai", id: model.id })).toBe(true);
    expect(saved.isVisible({ provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(false);
    expect(saved.isEnabled("anthropic")).toBe(false);
    const restored = await restart();
    expect(restored.runtime.hasConfiguredAuth("openai")).toBe(false);
    await connect(restored.runtime, "openai");
    expect((await restored.app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id: "openai", configured: true, enabled: true }));
  });

  it("removes persisted OAuth login locally and keeps the official subscription provider reconnectable after restart", async () => {
    const { app, runtime, directory, restart } = await fixture({ "auth.json": { openai: { type: "oauth", access: "test-access-token", refresh: "test-refresh-token", expires: Date.now() + 3_600_000 }, anthropic: otherCredential } });
    expect(await runtime.listCredentials()).toContainEqual({ providerId: "openai", type: "oauth" });
    const removed = await app.inject({ method: "DELETE", url: "/settings/models/providers/openai" });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(JSON.parse(await readFile(path.join(directory, "auth.json"), "utf8"))).toEqual({ anthropic: otherCredential });
    const restored = await restart();
    expect(restored.runtime.hasConfiguredAuth("openai")).toBe(false);
    expect((await restored.app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id: "openai", configured: false, methods: expect.arrayContaining([expect.objectContaining({ type: "oauth" })]) }));
  });

  it.each(["meshy", "tripo"])("clears %s's key, enable state and 3D default while preserving the other native connection", async (id) => {
    const other = id === "meshy" ? "tripo" : "meshy";
    const { app, directory, restart } = await fixture({
      "meshy.json": { version: 1, apiKey: "meshy-test-key" }, "tripo.json": { version: 1, apiKey: "tripo-test-key" },
      "model-visibility.json": { version: 1, hidden: {}, disabled: [id], defaultModel3D: { provider: id, id: "test-model" } },
    });
    expect((await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}` })).statusCode).toBe(204);
    await expect(readFile(path.join(directory, `${id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(directory, "models.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await preferences(directory)).defaultModel3D()).toBeUndefined();
    const restored = await restart();
    expect((await restored.app.inject({ method: "GET", url: "/settings/providers" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, configured: false, enabled: true }), expect.objectContaining({ id: other, configured: true }),
    ]));
    expect((await restored.app.inject({ method: "PUT", url: `/settings/models/providers/${id}`, payload: { apiKey: "new-test-key" } })).statusCode).toBe(200);
    expect((await restored.app.inject({ method: "GET", url: `/settings/models/providers/${id}` })).json()).toEqual({ configured: true });
  });

  it("clears only the selected Seedance connection and its global media defaults", async () => {
    const { app, directory, restart } = await fixture({
      "seedance.json": { version: 1, volcengineApiKey: "volc-test-key", byteplusApiKey: "byteplus-test-key" },
      "model-visibility.json": { version: 1, hidden: {}, defaultImageModel: { provider: "volcengine-ark", id: "seedream" }, defaultVideoModel: { provider: "volcengine-ark", id: "seedance" } },
    });
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/volcengine-ark" })).statusCode).toBe(204);
    expect(JSON.parse(await readFile(path.join(directory, "seedance.json"), "utf8"))).toEqual({ version: 1, byteplusApiKey: "byteplus-test-key" });
    const saved = await preferences(directory);
    expect(saved.defaultImageModel()).toBeUndefined();
    expect(saved.defaultVideoModel()).toBeUndefined();
    const restored = await restart();
    expect((await restored.app.inject({ method: "GET", url: "/settings/providers" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "volcengine-ark", configured: false }), expect.objectContaining({ id: "byteplus-modelark", configured: true }),
    ]));
  });

  it("deletes custom providers through the shared endpoint, including keyless local services", async () => {
    const { app, runtime, directory, restart } = await fixture();
    for (const authentication of ["api_key", "none"] as const) {
      const created = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { name: authentication, api: "openai-completions", baseUrl: "http://localhost:1234/v1", authentication, ...(authentication === "api_key" ? { apiKey: "custom-test-key" } : {}), models: [model] } });
      expect(created.statusCode, created.body).toBe(201);
      const { id } = created.json();
      expect((await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}` })).statusCode).toBe(204);
      expect(runtime.getProvider(id)).toBeUndefined();
      expect(await runtime.listCredentials()).not.toContainEqual(expect.objectContaining({ providerId: id }));
    }
    expect(await (await preferences(directory)).customProviderCatalog()).toEqual([]);
    const restored = await restart();
    expect((await restored.app.inject({ method: "GET", url: "/settings/providers" })).json().some((provider: { custom: boolean }) => provider.custom)).toBe(false);
  });

  it("rejects unknown providers without changing credentials or model settings", async () => {
    const files = { "auth.json": { anthropic: otherCredential }, "models.json": { providers: {} }, "model-visibility.json": { version: 1, hidden: {} } };
    const { app, directory } = await fixture(files);
    const before = await Promise.all(Object.keys(files).map((file) => readFile(path.join(directory, file), "utf8")));
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/nonexistent" })).statusCode).toBe(404);
    expect(await Promise.all(Object.keys(files).map((file) => readFile(path.join(directory, file), "utf8")))).toEqual(before);
  });

  it("restores model settings, endpoint and runtime state when credential removal fails, and permits retry", async () => {
    const { app, runtime, directory } = await fixture({
      "auth.json": { openai: { type: "api_key", key: "openai-test-key" } },
      "models.json": { providers: { openai: { models: [{ id: model.id, name: model.name }] } } },
      "openai-endpoint.json": { version: 1, baseUrl: "https://relay.example/v1" },
      "model-visibility.json": { version: 1, hidden: { openai: [model.id] }, disabled: ["openai"], defaultImageModel: { provider: "openai", id: "gpt-image-1" } },
    });
    vi.spyOn(runtime, "logout").mockRejectedValueOnce(new Error("Credential removal failed"));
    const removed = await app.inject({ method: "DELETE", url: "/settings/models/providers/openai" });
    expect(removed.statusCode).toBe(500);
    expect(runtime.hasConfiguredAuth("openai")).toBe(true);
    expect(runtime.getModel("openai", model.id)).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/settings/models/providers/openai/endpoint" })).json()).toEqual({ baseUrl: "https://relay.example/v1" });
    const saved = await preferences(directory);
    expect(saved.isEnabled("openai")).toBe(false);
    expect(saved.isVisible({ provider: "openai", id: model.id })).toBe(false);
    expect(saved.defaultImageModel()).toEqual({ provider: "openai", id: "gpt-image-1" });
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/openai" })).statusCode).toBe(204);
  });

  it.each(["meshy", "volcengine-ark"])("keeps %s configured when its credential file cannot be removed", async (id) => {
    const file = id === "meshy" ? "meshy.json" : "seedance.json";
    const { app, directory } = await fixture({ [file]: { version: 1, ...(id === "meshy" ? { apiKey: "test-key" } : { volcengineApiKey: "test-key" }) } });
    await rm(path.join(directory, file));
    await mkdir(path.join(directory, file));
    expect((await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}` })).statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id, configured: true }));
  });
});
