import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { normalizeCustomProviderModel, ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-provider-models-"));
  directories.push(directory);
  return { directory, store: new ProviderModelSettingsStore(directory, directory) };
}

const model = { id: "custom/test", name: "Custom test", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: true, supportsImages: true };

describe("provider model settings", () => {
  it("persists visibility per provider and serializes simultaneous updates", async () => {
    const { directory, store } = await fixture();
    await store.load();
    await Promise.all([store.setVisibility("openai", ["first"], false), store.setVisibility("openai", ["second"], false)]);
    const restored = new ProviderModelSettingsStore(directory, directory);
    await restored.load();
    expect(restored.isVisible({ provider: "openai", id: "first" })).toBe(false);
    expect(restored.isVisible({ provider: "openai", id: "second" })).toBe(false);
    expect(restored.isVisible({ provider: "other", id: "first" })).toBe(true);
    expect(restored.isVisible({ provider: "constructor", id: "first" })).toBe(true);
    await restored.setVisibility("openai", ["first"], true);
    expect(restored.isVisible({ provider: "openai", id: "first" })).toBe(true);
  });

  it("preserves JSONC comments, provider keys, overrides and unrelated models", async () => {
    const { directory, store } = await fixture();
    const modelsPath = path.join(directory, "models.json");
    await writeFile(modelsPath, '{\n  // Keep this comment\n  "providers": { "openai": { "apiKey": "KEY_ENV", "modelOverrides": { "existing": { "name": "Alias" } } }, "other": { "baseUrl": "https://other.example/v1" } }\n}\n');
    await store.addCustomModel("openai", model);
    expect((await readFile(modelsPath, "utf8"))).toContain("// Keep this comment");
    expect((await store.customModels("openai"))[0]).toMatchObject({ id: model.id, input: ["text", "image"], reasoning: true });
    await expect(store.addCustomModel("openai", model)).rejects.toThrow("already exists");
    await store.removeCustomModel("openai", model.id);
    const contents = await readFile(modelsPath, "utf8");
    expect(contents).toContain('"apiKey": "KEY_ENV"');
    expect(contents).toContain('"Alias"');
    expect(contents).toContain("https://other.example/v1");
    expect(await store.customModels("openai")).toEqual([]);
  });

  it("rejects broken config without replacing it", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "models.json"), "{broken");
    await expect(store.addCustomModel("openai", model)).rejects.toThrow("Invalid models.json");
    expect(await readFile(path.join(directory, "models.json"), "utf8")).toBe("{broken");
  });

  it("validates token limits and endpoints and keeps the provider endpoint inherited", () => {
    expect(normalizeCustomProviderModel(model, "openai-completions", "https://api.openai.com/v1")).not.toHaveProperty("baseUrl");
    for (const patch of [{ maxTokens: 0 }, { contextWindow: 1.5 }, { maxTokens: 40_000 }, { baseUrl: "file:///tmp/model" }, { baseUrl: "https://user:secret@example.com" }, { api: "unsupported" }, { id: " " }, { thinkingLevelMap: null }, { thinkingLevelMap: { unknown: "high" } }, { thinkingLevelMap: { high: true } }]) expect(() => normalizeCustomProviderModel({ ...model, ...patch }, "openai-completions", "https://api.openai.com/v1")).toThrow();
  });

  it("adds and removes models in the real Pi runtime and filters the selector after restart", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { directory } = await fixture();
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    const disconnected = await app.inject({ method: "GET", url: "/settings/models/providers/openai/models" });
    expect(disconnected.json().canAddCustomModel).toBe(false);
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: model })).statusCode).toBe(400);
    await runtime.setRuntimeApiKey("openai", "test-key");
    const added = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: model });
    expect(added.statusCode, added.body).toBe(201);
    expect(runtime.getModel("openai", model.id)).toMatchObject({ id: model.id, reasoning: true, contextWindow: 32_000 });
    expect(added.json().models).toContainEqual(expect.objectContaining({ id: model.id, custom: true, visible: true }));
    const duplicate = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: model });
    expect(duplicate.statusCode).toBe(409);
    const hidden = await app.inject({ method: "PUT", url: "/settings/models/providers/openai/models/visibility", payload: { ids: [model.id], visible: false } });
    expect(hidden.statusCode).toBe(200);
    const catalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(catalog.models.some((item: { id: string }) => item.id === model.id)).toBe(false);
    expect(catalog.hiddenModels).toContainEqual(expect.objectContaining({ id: model.id }));
    const invalid = await app.inject({ method: "PUT", url: "/settings/models/providers/openai/models/visibility", payload: { ids: ["unknown"], visible: true } });
    expect(invalid.statusCode).toBe(400);
    const restored = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(restored);
    expect((await restored.inject({ method: "GET", url: "/models" })).json().hiddenModels).toContainEqual(expect.objectContaining({ id: model.id }));
    const deleted = await app.inject({ method: "DELETE", url: `/settings/models/providers/openai/models/custom/${encodeURIComponent(model.id)}` });
    expect(deleted.statusCode).toBe(200);
    expect(runtime.getModel("openai", model.id)).toBeUndefined();
  });
});
