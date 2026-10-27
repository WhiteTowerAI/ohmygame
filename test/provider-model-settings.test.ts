import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { normalizeCustomProviderModel, ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { ModelCatalogRefresh } from "../src/daemon/model-catalog-refresh.js";

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Pi catalog refresh", () => {
  async function catalogFixture(providerId = "openai") {
    const { directory } = await fixture();
    await writeFile(path.join(directory, "auth.json"), JSON.stringify({ [providerId]: { type: "api_key", key: "fixture-key" } }));
    const request = vi.fn(async () => {});
    const createRuntime = async () => {
      const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), allowModelNetwork: false });
      const provider = runtime.getProvider(providerId)!;
      const baseline = runtime.getModels(providerId)[0]!;
      let models = [baseline];
      runtime.registerNativeProvider({ ...provider,
        getModels: () => models,
        getAllModels: () => models,
        refreshModels: async (context) => {
          if (!context.allowNetwork) { models = context.stored?.models as typeof models ?? [baseline]; return; }
          await request();
          const remote = [...models.filter((model) => model.id !== "catalog-new"), { ...baseline, id: "catalog-new", name: "New remote model" }];
          await context.publish({ persist: { models: remote, checkedAt: Date.now() }, update: () => { models = remote; } });
        },
      });
      await runtime.refresh({ allowNetwork: false });
      return runtime;
    };
    const runtime = await createRuntime();
    vi.stubEnv("PI_OFFLINE", undefined);
    return { directory, runtime, request, createRuntime };
  }

  it("returns the local list while refreshing, publishes the result and preserves it across restart", async () => {
    const { directory, runtime, request, createRuntime } = await catalogFixture();
    let release!: () => void;
    request.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    const first = await app.inject({ method: "GET", url: "/models" });
    expect(first.statusCode).toBe(200);
    expect(first.json().loadingProviders).toContain("openai");
    expect(first.json().models.some((model: { id: string }) => model.id === "catalog-new")).toBe(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    // Concurrent readers share the pending refresh instead of issuing more network requests.
    await app.inject({ method: "GET", url: "/settings/models/providers/openai/models" });
    expect(request).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(async () => {
      const models = (await app.inject({ method: "GET", url: "/models" })).json();
      expect(models.loadingProviders).toBeUndefined();
      expect(models.models).toContainEqual(expect.objectContaining({ id: "catalog-new" }));
    });
    const hidden = await app.inject({ method: "PUT", url: "/settings/models/providers/openai/models/visibility", payload: { ids: ["catalog-new"], visible: false } });
    expect(hidden.statusCode).toBe(200);
    await runtime.login("openai", "api_key", { signal: new AbortController().signal, notify: () => {}, prompt: async () => "fixture-key" });
    request.mockResolvedValue();
    const choice = first.json().models[0];
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model: { provider: "openai", id: choice.id }, reasoningLevel: choice.reasoningLevels[0] } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/custom", payload: { ...model, id: "user-model" } })).statusCode).toBe(201);
    const forced = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/refresh" });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().models).toContainEqual(expect.objectContaining({ id: "catalog-new", visible: false }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(runtime.getModel("openai", "user-model")).toMatchObject({ id: "user-model", contextWindow: model.contextWindow });
    expect((await app.inject({ method: "GET", url: "/models" })).json().defaultModel).toEqual({ provider: "openai", id: choice.id });
    vi.stubEnv("PI_OFFLINE", "1");
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/refresh" })).statusCode).toBe(400);
    const restored = await createRuntime();
    expect(restored.getModel("openai", "catalog-new")).toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps cached models on failure, backs off automatic retries and allows an explicit retry", async () => {
    const { directory, runtime, request } = await catalogFixture();
    request.mockRejectedValue(new Error("private-provider-token"));
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    const initial = (await app.inject({ method: "GET", url: "/models" })).json();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const failed = await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/refresh" });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("private-provider-token");
    const calls = request.mock.calls.length;
    const cached = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(cached.models).toEqual(initial.models);
    expect(request).toHaveBeenCalledTimes(calls);
    request.mockResolvedValue();
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/openai/models/refresh" })).statusCode).toBe(200);
    expect(runtime.getModel("openai", "catalog-new")).toBeDefined();
  });

  it("rechecks Pi's persisted cache when it expires, without adding another four-hour delay after restart", async () => {
    const { directory } = await fixture();
    await writeFile(path.join(directory, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-key" } }));
    const createRuntime = () => ModelRuntime.create({
      authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"),
      catalogBaseUrl: "https://catalog.example", allowModelNetwork: false,
    });
    const runtime = await createRuntime();
    const model = { ...runtime.getModels("openai")[0]!, id: "remote-cached-model" };
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ models: [model] }, {
      headers: { "last-modified": "Thu, 01 Jan 2099 00:00:00 GMT", etag: '"catalog-v1"' },
    }));
    vi.stubGlobal("fetch", request);
    vi.stubEnv("PI_OFFLINE", undefined);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await new ModelCatalogRefresh(() => true).refresh(runtime, "openai");
    expect(request).toHaveBeenCalledOnce();
    expect(runtime.getModel("openai", model.id)).toBeDefined();

    clock.mockReturnValue(now + 3 * 60 * 60_000);
    const restarted = await createRuntime();
    const refresh = new ModelCatalogRefresh(() => true);
    await refresh.refresh(restarted, "openai");
    expect(request).toHaveBeenCalledOnce();
    expect(restarted.getModel("openai", model.id)).toBeDefined();

    clock.mockReturnValue(now + 4 * 60 * 60_000 + 1);
    await refresh.refresh(restarted, "openai");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ headers: { "if-none-match": '"catalog-v1"' } });
  });

  it("runs a forced manual refresh after an automatic check and shares simultaneous manual requests", async () => {
    const { runtime, request } = await catalogFixture();
    let release!: () => void;
    request.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const calls = vi.spyOn(runtime, "refresh");
    const refresh = new ModelCatalogRefresh(() => true);
    const automatic = refresh.refresh(runtime, "openai");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const manual = refresh.refresh(runtime, "openai", true);
    const secondManual = refresh.refresh(runtime, "openai", true);
    release();
    await Promise.all([automatic, manual, secondManual]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls.map(([options]) => options?.force)).toEqual([false, true]);
  });

  it("throttles automatic refreshes, invalidates account changes and aborts on shutdown", async () => {
    const { runtime, request } = await catalogFixture("openrouter");
    let enabled = true;
    const refresh = new ModelCatalogRefresh(() => enabled);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await refresh.refresh(runtime, "openrouter");
    await refresh.refresh(runtime, "openrouter");
    expect(request).toHaveBeenCalledOnce();
    clock.mockReturnValue(now + 4 * 60 * 60_000);
    await refresh.refresh(runtime, "openrouter");
    expect(request).toHaveBeenCalledTimes(2);
    refresh.invalidate("openrouter");
    await refresh.refresh(runtime, "openrouter");
    expect(request).toHaveBeenCalledTimes(3);
    enabled = false;
    expect(refresh.canRefresh(runtime, "openrouter")).toBe(false);
    enabled = true;
    vi.stubEnv("PI_OFFLINE", "1");
    expect(refresh.schedule(runtime)).toEqual([]);
    vi.stubEnv("PI_OFFLINE", undefined);
    request.mockImplementation(() => new Promise(() => {}));
    const pending = refresh.refresh(runtime, "openrouter", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    refresh.close();
    await expect(pending).rejects.toThrow("Model catalog refresh failed");
    expect(refresh.schedule(runtime)).toEqual([]);
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-provider-models-"));
  directories.push(directory);
  return { directory, store: new ProviderModelSettingsStore(directory, directory) };
}

const model = { id: "custom/test", name: "Custom test", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: true, supportsImages: true };

describe("provider model settings", () => {
  it("isolates inherited provider credentials while allowing explicit test credentials", async () => {
    const { directory } = await fixture();
    // A fresh process exercises the setup with inherited credentials before Pi
    // creates its availability snapshot, without changing this worker's environment.
    const script = `
      import assert from "node:assert/strict";
      import { ModelRuntime } from "@earendil-works/pi-coding-agent";
      const options = {
        authPath: ${JSON.stringify(path.join(directory, "auth.json"))},
        modelsPath: ${JSON.stringify(path.join(directory, "models.json"))},
        allowModelNetwork: false,
      };
      const inherited = await ModelRuntime.create(options);
      assert.equal(inherited.hasConfiguredAuth("anthropic"), true);
      await import("./test/provider-environment.ts");
      const isolated = await ModelRuntime.create(options);
      assert.deepEqual(await isolated.getAvailable(), []);
      await isolated.setRuntimeApiKey("anthropic", "fixture-key");
      assert.equal(isolated.hasConfiguredAuth("anthropic"), true);
      console.log("provider-environment-ok");
    `;
    const { stdout } = await promisify(execFile)(
      "node",
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GEMINI_API_KEY: "fixture-key",
          OPENAI_API_KEY: "fixture-key",
          HF_TOKEN: "fixture-token",
          COPILOT_GITHUB_TOKEN: "fixture-token",
          AWS_PROFILE: "fixture-profile",
          ANTHROPIC_FEDERATION_RULE_ID: "fixture-rule",
          ANTHROPIC_ORGANIZATION_ID: "fixture-org",
          ANTHROPIC_IDENTITY_TOKEN_FILE: path.join(directory, "identity-token"),
          ANTHROPIC_SERVICE_ACCOUNT_ID: "fixture-account",
          ANTHROPIC_WORKSPACE_ID: "fixture-workspace",
        },
        timeout: 15_000,
      },
    );
    expect(stdout.trim()).toBe("provider-environment-ok");
  });

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
