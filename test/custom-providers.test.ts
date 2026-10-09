import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { customModelCatalog } from "../src/daemon/custom-model-capabilities.js";
import { initialCustomThinkingLevelMap, invalidateCustomModelCapabilities, modelError } from "../src/renderer/custom-provider-models.js";
import { AGENT_REASONING_LEVELS, type CustomProviderModel } from "../src/shared/contracts.js";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";
import { MeshyProvider } from "../src/daemon/meshy-provider.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const firstModel = { id: "local-model", name: "Local model", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false };
const gateway = { name: "My gateway", baseUrl: "https://gateway.example/v1", api: "openai-completions", authentication: "api_key" as const, apiKey: "test-secret-key", models: [firstModel] };

async function fixture(prompt = vi.fn(async () => {}), modelDiscoveryFetch?: typeof fetch, imageFetch?: typeof fetch) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-custom-providers-"));
  directories.push(directory);
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const abort = vi.fn(async () => {});
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, modelDiscoveryFetch, imageFetch, createModelRuntime: async () => runtime, createSession: async () => ({ messages: [], prompt, abort, dispose: () => {}, subscribe: () => () => {} }) });
  apps.push(app);
  const create = async (payload = gateway) => {
    const result = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload });
    expect(result.statusCode, result.body).toBe(201);
    return result.json() as { id: string };
  };
  return { directory, runtime, app, create, prompt, abort };
}

describe("custom providers", () => {
  it("keeps the local service identity in provider summaries after renaming and disabling it", async () => {
    const { app } = await fixture();
    const payload = { name: "Home server", preset: "ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2, models: [{ ...firstModel, usages: { language: true } }] };
    const created = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const renamed = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...payload, name: "Renamed local server" } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/settings/models/providers/${id}/enabled`, payload: { enabled: false } })).statusCode).toBe(200);
    const providers = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(providers).toContainEqual(expect.objectContaining({ id, name: "Renamed local server", preset: "ollama", custom: true, configured: true, enabled: false, capabilities: ["language"] }));
  });

  it("rejects duplicate custom names on creation and renaming without changing existing settings or credentials", async () => {
    const { app, directory, runtime, create } = await fixture();
    const first = await create();
    const second = await create({ ...gateway, name: "Other gateway" });
    const files = ["models.json", "model-visibility.json", "auth.json"];
    const before = await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")));
    for (const name of [gateway.name, "  MY GATEWAY  "]) {
      const result = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...gateway, name, apiKey: "different-key" } });
      expect(result.statusCode, result.body).toBe(400);
      expect(result.json().error).toContain("with this name already exists");
    }
    const rename = await app.inject({ method: "PUT", url: `/settings/models/providers/${second.id}/custom`, payload: { ...gateway, name: "my gateway", apiKey: "different-key" } });
    expect(rename.statusCode, rename.body).toBe(400);
    expect(rename.json().error).toContain("with this name already exists");
    expect(await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).toEqual(before);
    expect((await runtime.getAuth(second.id))?.auth.apiKey).toBe(gateway.apiKey);
    const sameName = await app.inject({ method: "PUT", url: `/settings/models/providers/${first.id}/custom`, payload: { ...gateway, apiKey: undefined } });
    expect(sameName.statusCode, sameName.body).toBe(200);
    const uniqueName = await app.inject({ method: "PUT", url: `/settings/models/providers/${second.id}/custom`, payload: { ...gateway, name: "Renamed gateway", apiKey: undefined } });
    expect(uniqueName.statusCode, uniqueName.body).toBe(200);
  });

  it("serializes duplicate-name checks so simultaneous creates cannot save the same name", async () => {
    const { app, directory } = await fixture();
    const results = await Promise.all([gateway.name, "MY GATEWAY"].map((name) => app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...gateway, name } })));
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 400]);
    const store = new ProviderModelSettingsStore(directory, directory);
    await store.load();
    expect(await store.customProviderCatalog()).toHaveLength(1);
  });

  it("keeps existing duplicate names editable until the user chooses distinct names", async () => {
    const { app, directory, runtime } = await fixture();
    const ids = ["custom-legacy-first", "custom-legacy-second"];
    await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: Object.fromEntries(ids.map((id) => [id, {
      name: gateway.name, api: gateway.api, baseUrl: gateway.baseUrl, models: [{ ...firstModel, supportsImages: undefined, input: ["text"] }],
    }])) }));
    await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: {}, customProviders: Object.fromEntries(ids.map((id) => [id, { authentication: "api_key" }])) }));
    await runtime.refresh({ allowNetwork: false });
    for (const id of ids) await runtime.setRuntimeApiKey(id, gateway.apiKey);
    const update = await app.inject({ method: "PUT", url: `/settings/models/providers/${ids[1]}/custom`, payload: { ...gateway, apiKey: undefined, baseUrl: "https://new-gateway.example/v1" } });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json()).toMatchObject({ name: gateway.name, baseUrl: "https://new-gateway.example/v1" });
    const rename = await app.inject({ method: "PUT", url: `/settings/models/providers/${ids[1]}/custom`, payload: { ...gateway, apiKey: undefined, name: "Distinct gateway" } });
    expect(rename.statusCode, rename.body).toBe(200);
    const names = await Promise.all(ids.map(async (id) => (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json().name));
    expect(names).toEqual([gateway.name, "Distinct gateway"]);
  });

  it("passes canvas text and document reasoning to the runtime, uses defaults, and rejects unsupported levels", async () => {
    const { runtime, app, create } = await fixture();
    const { id } = await create({ ...gateway, models: [{ ...firstModel, reasoning: true }] });
    const model = { provider: id, id: firstModel.id };
    const response = { role: "assistant", content: [{ type: "text", text: "Generated rules" }], stopReason: "stop" } as Awaited<ReturnType<typeof runtime.completeSimple>>;
    const complete = vi.spyOn(runtime, "completeSimple").mockResolvedValue(response);
    const stream = vi.spyOn(runtime, "streamSimple").mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: response }; },
    }) as unknown as ReturnType<typeof runtime.streamSimple>);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
    const created = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/documents`, payload: { title: "Rules" } });
    expect(created.statusCode, created.body).toBe(201);
    const document = created.json();
    const textUrl = `/projects/${project.id}/canvas/text/generate`;
    const documentUrl = `/projects/${project.id}/canvas/documents/${document.document.id}/generate`;
    for (const [url, extra] of [[textUrl, {}], [documentUrl, { revision: document.revision }]] as const) {
      const result = await app.inject({ method: "POST", url, payload: { instruction: "Write rules", model, reasoningLevel: "high", ...extra } });
      expect(result.statusCode, result.body).toBe(200);
      if (url === documentUrl) expect(result.json()).toMatchObject({ status: "complete", markdown: "Generated rules" });
      const generate = url === documentUrl ? stream : complete;
      expect(generate).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ reasoning: "high" }));
      const calls = generate.mock.calls.length;
      for (const reasoningLevel of ["max", "turbo"]) {
        const rejected = await app.inject({ method: "POST", url, payload: { instruction: "Write rules", model, reasoningLevel, ...extra } });
        expect(rejected.statusCode, rejected.body).toBe(400);
      }
      expect(generate).toHaveBeenCalledTimes(calls);
    }
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model, reasoningLevel: "high" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: textUrl, payload: { instruction: "Write rules" } })).statusCode).toBe(200);
    expect(complete.mock.lastCall?.[2]?.reasoning).toBe("high");
    expect((await app.inject({ method: "POST", url: textUrl, payload: { instruction: "Write rules", model, reasoningLevel: "off" } })).statusCode).toBe(200);
    expect(complete.mock.lastCall?.[2]).not.toHaveProperty("reasoning");
  });

  it("fills missing GPT relay capabilities from the catalog and preserves reasoning levels through edits", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-5.4" }, { id: "gpt-4o" }, { id: "gpt-image-2.5-flare" }] }));
    const { directory, runtime, app, create } = await fixture(undefined, request);
    const discovery = await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: gateway });
    expect(discovery.statusCode, discovery.body).toBe(200);
    const models = discovery.json().models;
    expect(models.map((model: { id: string }) => model.id)).toEqual(["gpt-5.4", "gpt-4o", "gpt-image-2.5-flare"]);
    expect(models[2].usages.image.protocol).toBe("openai-images");
    expect(models[0]).toMatchObject({ reasoning: true, supportsImages: true, reasoningCapabilities: { source: "catalog", thinkingLevelMap: { xhigh: "xhigh", max: null } } });
    expect(models[1].reasoning).toBe(false);
    const { id } = await create({ ...gateway, models });
    expect(runtime.getModel(id, "gpt-5.4")?.thinkingLevelMap).toBeUndefined();
    expect(await readFile(path.join(directory, "models.json"), "utf8")).not.toContain("thinkingLevelMap");
    const modelCatalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(modelCatalog.models).toContainEqual(expect.objectContaining({ provider: id, id: "gpt-5.4", reasoningLevels: ["off", "low", "medium", "high", "xhigh"] }));
    const update = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...gateway, apiKey: undefined, models: [{ ...models[0], reasoning: false }] } });
    expect(update.statusCode, update.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/models" })).json().models).toContainEqual(expect.objectContaining({ provider: id, id: "gpt-5.4", reasoningLevels: ["off"] }));
    const enable = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...gateway, apiKey: undefined, models: [{ ...models[0], thinkingLevelMap: undefined, reasoning: true }] } });
    expect(enable.statusCode, enable.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/models" })).json().models).toContainEqual(expect.objectContaining({ provider: id, id: "gpt-5.4", reasoningLevels: ["off", "low", "medium", "high", "xhigh"] }));
  });

  it("resolves an existing GPT-6.1 relay at load time without fetching or rewriting it", async () => {
    const { directory, runtime, app } = await fixture();
    const id = "custom-legacy";
    const model = { ...firstModel, id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: true };
    // A provider created by the previous version, with no reasoning map on disk.
    const definition = { ...model, input: ["text"], supportsImages: undefined };
    const original = JSON.stringify({ providers: { [id]: { name: gateway.name, api: gateway.api, baseUrl: gateway.baseUrl, models: [definition] } } });
    await writeFile(path.join(directory, "models.json"), original);
    await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: {}, customProviders: { [id]: { authentication: "api_key" } } }));
    await runtime.refresh({ allowNetwork: false });
    await runtime.setRuntimeApiKey(id, "fixture-key");
    const levels = ["low", "medium", "high", "xhigh", "max"];
    const catalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(catalog.models).toContainEqual(expect.objectContaining({ provider: id, id: model.id, reasoningLevels: levels }));
    expect((await app.inject({ method: "GET", url: `/settings/models/providers/${id}/models` })).json().models[0].reasoningLevels).toEqual(levels);
    const details = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json();
    expect(details.models[0]).toMatchObject({ reasoningCapabilities: { source: "catalog", thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } } });
    const selected = { provider: id, id: model.id };
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model: selected, reasoningLevel: "max" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model: selected, reasoningLevel: "minimal" } })).statusCode).toBe(400);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: { model: selected, reasoningLevel: "xhigh" } });
    expect(conversation.statusCode, conversation.body).toBe(201);
    const detailsOfConversation = (await app.inject({ method: "GET", url: `/projects/${project.id}/conversations/${conversation.json().id}` })).json();
    expect(detailsOfConversation.settings.reasoningLevel).toBe("xhigh");
    expect(await readFile(path.join(directory, "models.json"), "utf8")).toBe(original);
  });

  it("saves the catalog levels after changing an endpoint and switching to Custom", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-6.1-sol", supported_reasoning_efforts: ["low", "high", "ultra"] }] }));
    const { app, create } = await fixture(undefined, request);
    const discovered = (await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: gateway })).json().models[0];
    const { id } = await create({ ...gateway, models: [discovered] });
    const changed = invalidateCustomModelCapabilities(discovered as CustomProviderModel);
    const custom = { ...changed, thinkingLevelMap: initialCustomThinkingLevelMap(changed) };
    expect(modelError(custom)).toBeUndefined();
    const saved = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...gateway, apiKey: undefined, baseUrl: "https://other-gateway.example/v1", models: [custom] } });
    expect(saved.statusCode, saved.body).toBe(200);
    const catalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(catalog.models).toContainEqual(expect.objectContaining({ provider: id, id: custom.id, reasoningLevels: ["low", "medium", "high", "xhigh", "max"] }));
  });

  it("reads the catalog once for a batch of 2,000 relay models", async () => {
    const { app, runtime, create } = await fixture();
    const models = Array.from({ length: 2_000 }, (_, index) => ({ ...firstModel, id: index === 0 ? "gpt-6.1-sol" : `fixture-${index}`, reasoning: true }));
    const { id } = await create({ ...gateway, models });
    const getModels = vi.spyOn(runtime, "getModels");
    try {
      const result = await app.inject({ method: "GET", url: "/models" });
      expect(result.statusCode, result.body).toBe(200);
      const selected = result.json().models.filter((model: { provider: string }) => model.provider === id);
      expect(selected).toHaveLength(2_000);
      expect(selected.find((model: { id: string }) => model.id === "gpt-6.1-sol").reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(selected.find((model: { id: string }) => model.id === "fixture-1").reasoningLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
      expect(getModels.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
    } finally { getModels.mockRestore(); }
  });

  it("can edit and fetch again when manual overrides leave only catalog reasoning levels enabled", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-6.1-sol" }] }));
    const { app, create } = await fixture(undefined, request);
    const model = { ...firstModel, id: "gpt-6.1-sol", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null } };
    const { id } = await create({ ...gateway, models: [model] });
    const update = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...gateway, apiKey: undefined, name: "Renamed gateway", models: [model] } });
    expect(update.statusCode, update.body).toBe(200);
    const fetched = await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: { ...gateway, apiKey: undefined, providerId: id, models: undefined } });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(request).toHaveBeenCalledOnce();
    expect((await app.inject({ method: "GET", url: "/models" })).json().models).toContainEqual(expect.objectContaining({ provider: id, reasoningLevels: ["xhigh", "max"] }));
  });

  it.each(["manual", "reported"])("saves disabled reasoning with no enabled %s levels and rejects re-enabling it", async (source) => {
    const { app, create } = await fixture();
    const allDisabled = Object.fromEntries(AGENT_REASONING_LEVELS.map((level) => [level, null]));
    const disabled: CustomProviderModel = {
      ...firstModel, reasoning: false,
      thinkingLevelMap: source === "manual" ? allDisabled : { low: null },
      ...(source === "reported" ? { reasoningCapabilities: { source: "provider", thinkingLevelMap: { ...allDisabled, low: "low" } } } : {}),
    };
    expect(modelError(disabled)).toBeUndefined();
    const { id } = await create({ ...gateway, models: [disabled] });
    const details = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json();
    expect(details.models[0]).toMatchObject({ reasoning: false, thinkingLevelMap: disabled.thinkingLevelMap });
    expect((await app.inject({ method: "GET", url: "/models" })).json().models).toContainEqual(expect.objectContaining({ provider: id, reasoningLevels: ["off"] }));
    const enable = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...gateway, apiKey: undefined, models: [{ ...disabled, reasoning: true }] } });
    expect(enable.statusCode, enable.body).toBe(400);
    expect(enable.json().error).toContain("Enable at least one");
    const invalid = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...gateway, apiKey: undefined, models: [{ ...disabled, thinkingLevelMap: { max: "" } }] } });
    expect(invalid.statusCode).toBe(400);
  });

  it.each(["openai-completions", "openai-responses"])("sends xhigh/max and explicit relay overrides through the real %s adapter", async (api) => {
    const { directory, runtime, create } = await fixture();
    const model = { ...firstModel, id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api, reasoning: true };
    const { id } = await create({ ...gateway, api, models: [model] });
    const store = new ProviderModelSettingsStore(directory, directory);
    await store.load();
    const raw = runtime.getModel(id, model.id)!;
    const resolved = store.resolveModel(raw, customModelCatalog(runtime.getModels()));
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: { message: "Stopped by test fixture" } }, { status: 400 }));
    for (const [level, expected] of [["xhigh", "xhigh"], ["max", "max"], ["max", "ultra"]] as const) {
      const sentModel = expected === "ultra" ? { ...resolved, thinkingLevelMap: { ...resolved.thinkingLevelMap, max: "ultra" } } : resolved;
      const result = await runtime.completeSimple(sentModel, { messages: [{ role: "user", content: "Test", timestamp: 1 }] }, { reasoning: level, fetch: request, maxRetries: 0 });
      expect(result.stopReason).toBe("error");
      const payload = JSON.parse(String(request.mock.lastCall?.[1]?.body));
      expect(api === "openai-responses" ? payload.reasoning?.effort : payload.reasoning_effort).toBe(expected);
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(raw.thinkingLevelMap).toBeUndefined();
  });

  it("retains reported capabilities across restart, preserves manual overrides and restores automatic mode", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-6.1-sol", supported_reasoning_efforts: ["low", "high", "ultra"] }] }));
    const { directory, runtime, app, create } = await fixture(undefined, request);
    const discovered = (await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: gateway })).json().models[0];
    const manual = { ...discovered, thinkingLevelMap: { max: "relay-max", low: null } };
    const { id } = await create({ ...gateway, models: [manual] });
    const store = new ProviderModelSettingsStore(directory, directory);
    await store.load();
    expect(store.resolveModel(runtime.getModel(id, manual.id)!, customModelCatalog(runtime.getModels())).thinkingLevelMap).toMatchObject({ minimal: null, low: null, max: "relay-max" });
    const restored = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(restored);
    expect((await restored.inject({ method: "GET", url: "/models" })).json().models).toContainEqual(expect.objectContaining({ provider: id, reasoningLevels: ["high", "max"] }));
    const url = `/settings/models/providers/${id}/custom`;
    const details = (await restored.inject({ method: "GET", url })).json();
    expect(details.models[0]).toMatchObject({ thinkingLevelMap: manual.thinkingLevelMap, reasoningCapabilities: { source: "provider", thinkingLevelMap: { max: "ultra" } } });
    expect(details.models[0].reasoningCapabilities.catalogThinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
    for (const file of ["models.json", "model-visibility.json"]) expect(await readFile(path.join(directory, file), "utf8")).not.toContain("catalogThinkingLevelMap");
    const reset = await restored.inject({ method: "PUT", url, payload: { ...gateway, apiKey: undefined, models: [{ ...details.models[0], thinkingLevelMap: undefined }] } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().models[0]).not.toHaveProperty("thinkingLevelMap");
    expect(await readFile(path.join(directory, "models.json"), "utf8")).not.toContain("thinkingLevelMap");
    expect((await restored.inject({ method: "GET", url: "/models" })).json().models).toContainEqual(expect.objectContaining({ provider: id, reasoningLevels: ["low", "high", "max"] }));
    expect(runtime.getModel(id, manual.id)?.thinkingLevelMap).toBeUndefined();
    const changedEndpoint = await restored.inject({ method: "PUT", url, payload: { ...gateway, apiKey: undefined, models: undefined, baseUrl: "https://other-gateway.example/v1" } });
    expect(changedEndpoint.statusCode, changedEndpoint.body).toBe(200);
    expect(changedEndpoint.json().models[0].reasoningCapabilities).toMatchObject({ source: "catalog", thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
  });

  it("shares a relay connection with image generation and uses its saved default without a canvas", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input) === `${gateway.baseUrl}/models`
      ? Response.json({ data: [{ id: "gpt-image-1" }, { id: "gpt-image-2.5-flare" }, { id: "gpt-5.4" }] })
      : String(input).startsWith(`${gateway.baseUrl}/images/`)
        ? Response.json({ data: [{ b64_json: Buffer.from("relay image").toString("base64") }] })
        : Response.json({ data: [] }));
    const { directory, runtime, app, create } = await fixture(undefined, undefined, request);
    const { id } = await create();
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id, capabilities: ["language", "image"] }));
    const catalog = (await app.inject({ method: "GET", url: "/image-models/catalog" })).json();
    expect(catalog.models.map((model: { provider: string; id: string }) => [model.provider, model.id])).toEqual([[id, "gpt-image-2.5-flare"], [id, "gpt-image-1"]]);
    const defaultModel = { provider: id, id: "gpt-image-1" };
    expect((await app.inject({ method: "PUT", url: "/image-models/default", payload: defaultModel })).statusCode).toBe(204);
    const restored = new ProviderModelSettingsStore(directory, directory);
    await restored.load();
    expect(restored.defaultImageModel()).toEqual(defaultModel);
    const after = (await app.inject({ method: "GET", url: "/image-models/catalog" })).json();
    expect(after.defaultModel).toEqual(defaultModel);
    expect(after.models[0]).toMatchObject(defaultModel);

    const response = await app.inject({ method: "POST", url: "/tools/generate-image/jobs", payload: { prompt: "Make a game icon" } });
    expect(response.statusCode, response.body).toBe(202);
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/tool-jobs" })).json();
      expect(jobs.find((job: { id: string }) => job.id === response.json().id)?.status).toBe("succeeded");
    }, { timeout: 5_000 });
    const generated = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generated?.[0]).toBe(`${gateway.baseUrl}/images/generations`);
    expect(generated?.[1]?.headers).toMatchObject({ authorization: `Bearer ${gateway.apiKey}` });
    expect(JSON.parse(String(generated?.[1]?.body))).toMatchObject({ model: "gpt-image-1" });
    expect((await runtime.getAuth(id))?.auth?.apiKey).toBe(gateway.apiKey);
    expect(after).not.toHaveProperty("apiKey");

    expect((await app.inject({ method: "PUT", url: "/image-models/default", payload: { provider: "openai", id: "gpt-image-1" } })).statusCode).toBe(400);
    await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}/custom` });
    const removed = new ProviderModelSettingsStore(directory, directory);
    await removed.load();
    expect(removed.defaultImageModel()).toBeUndefined();
  });

  it("routes canvas reference-image requests to the chosen relay, preserves provider identity and honors disabling it", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input) === `${gateway.baseUrl}/models`
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : String(input).endsWith("/images/edits")
        ? Response.json({ data: [{ b64_json: Buffer.from("cover").toString("base64") }] })
        : Response.json({ data: [] }));
    const { runtime, app, create } = await fixture();
    const { id } = await create();
    const store = new ProviderModelSettingsStore(directories.at(-1)!, directories.at(-1)!);
    await store.load();
    const images = new ProviderImages(async () => runtime, request, undefined, (provider) => store.isEnabled(provider), { customProviders: () => store.customProviderCatalog() });
    const input = { prompt: "Cover", imageModel: { provider: id, id: "gpt-image-2.5-flare" }, resolution: "2K" as const, aspectRatio: "16:9" as const, images: [{ mediaType: "image/png" as const, data: Buffer.from("reference").toString("base64") }] };
    await expect(images.generate(input)).resolves.toMatchObject({ bytes: Buffer.from("cover") });
    const generated = request.mock.calls.find(([url]) => String(url).endsWith("/images/edits"));
    expect(generated?.[0]).toBe(`${gateway.baseUrl}/images/edits`);
    const form = generated?.[1]?.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2.5-flare");
    expect(form.get("size")).toBe("2048x1152");
    expect(form.getAll("image[]")).toHaveLength(1);
    await expect(images.generate({ ...input, imageModel: { provider: "openai", id: input.imageModel.id } })).rejects.toThrow("selected image model is unavailable");
    await store.setEnabled(id, false);
    request.mockClear();
    expect((await images.catalog()).models).toEqual([]);
    await expect(images.generate(input)).rejects.toThrow("disabled");
    expect(request).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).statusCode).toBe(200);
  });

  it("saves a keyed provider without fetching or selecting models, then discovers with its saved key", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "first" }, { id: "second" }] }));
    const { directory, runtime, app } = await fixture(undefined, request);
    const response = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...gateway, models: [] } });
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().id;
    expect(request).not.toHaveBeenCalled();
    expect(runtime.getModels(id)).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id, configured: true }));
    const authPath = path.join(directory, "auth.json");
    const before = await readFile(authPath, "utf8");
    const discovered = await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: { providerId: id, baseUrl: gateway.baseUrl, api: gateway.api, authentication: "api_key" } });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${gateway.apiKey}` });
    expect(discovered.body).not.toContain(gateway.apiKey);
    expect(runtime.getModels(id)).toEqual([]);
    expect(await readFile(authPath, "utf8")).toBe(before);
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: { providerId: "openai", baseUrl: gateway.baseUrl, api: gateway.api, authentication: "api_key" } })).statusCode).toBe(404);
  });

  it("edits model definitions and enable state together, preserving disabled models, comments and pricing", async () => {
    const { directory, runtime, app, create } = await fixture();
    const { id } = await create();
    const modelsPath = path.join(directory, "models.json");
    const original = await readFile(modelsPath, "utf8");
    await writeFile(modelsPath, original.replace('"contextWindow": 32000', '// Keep model comment\n          "contextWindow": 32000').replace('"input": 0', '"input": 2'));
    const changed = { ...firstModel, name: "Edited model", contextWindow: 64_000, maxTokens: 8_000, supportsImages: true };
    const second = { ...firstModel, id: "second-model" };
    const payload = { ...gateway, apiKey: undefined, models: [changed, second], hiddenModelIds: [changed.id] };
    const update = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload });
    expect(update.statusCode, update.body).toBe(200);
    expect(runtime.getModel(id, changed.id)).toMatchObject({ name: changed.name, contextWindow: 64_000, maxTokens: 8_000, input: ["text", "image"], cost: { input: 2 } });
    expect(await readFile(modelsPath, "utf8")).toContain("// Keep model comment");
    const loaded = (await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).json();
    expect(loaded.models).toEqual([changed, second]);
    expect(loaded.hiddenModelIds).toEqual([changed.id]);
    expect(update.json()).toEqual(loaded);
    expect(JSON.stringify(loaded)).not.toContain(gateway.apiKey);
    const catalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect(catalog.models).toContainEqual(expect.objectContaining({ provider: id, id: second.id }));
    expect(catalog.models).not.toContainEqual(expect.objectContaining({ provider: id, id: changed.id }));
    expect(catalog.hiddenModels).toContainEqual(expect.objectContaining({ provider: id, id: changed.id }));
    expect((await runtime.getAuth(id))?.auth?.apiKey).toBe(gateway.apiKey);
    const invalid = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...payload, hiddenModelIds: ["unknown"] } });
    expect(invalid.statusCode).toBe(400);
    const enabled = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: { ...payload, hiddenModelIds: [] } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect((await app.inject({ method: "GET", url: `/settings/models/providers/${id}/models` })).json().models.every((model: { visible: boolean }) => model.visible)).toBe(true);
  });

  it("discovers without persisting credentials and imports only the selected models together", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "first" }, { id: "second" }, { id: "third" }] }));
    const { directory, runtime, app } = await fixture(undefined, request);
    const authPath = path.join(directory, "auth.json");
    const before = await readFile(authPath, "utf8").catch(() => undefined);
    const result = await app.inject({ method: "POST", url: "/settings/models/providers/discover", payload: { baseUrl: gateway.baseUrl, api: gateway.api, authentication: gateway.authentication, apiKey: gateway.apiKey } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.body).not.toContain(gateway.apiKey);
    expect(await readFile(authPath, "utf8").catch(() => undefined)).toBe(before);
    const models = result.json().models;
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...gateway, models: [models[0], models[2]].map((model) => ({ ...model, usages: { language: true } })) } });
    expect(saved.statusCode, saved.body).toBe(201);
    const id = saved.json().id;
    expect(runtime.getModels(id).map((model) => model.id)).toEqual(["first", "third"]);
    expect(await runtime.getAvailable(id)).toHaveLength(2);
    const duplicate = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...gateway, models: [models[0], models[0]] } });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toContain("unique");
  });
  it("creates independent keyed and local providers without exposing credentials, and inherits protocol for an empty provider", async () => {
    const { directory, runtime, app, create } = await fixture();
    const keyed = await create();
    const localResponse = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { name: "Local service", baseUrl: "http://localhost:1234/v1", api: "anthropic-messages", authentication: "none" } });
    expect(localResponse.statusCode, localResponse.body).toBe(201);
    const local = localResponse.json();
    expect(local.id).not.toBe(keyed.id);
    const settings = (await app.inject({ method: "GET", url: `/settings/models/providers/${local.id}/models` })).json();
    expect(settings).toMatchObject({ models: [], defaultApi: "anthropic-messages", defaultBaseUrl: "http://localhost:1234/v1", canAddCustomModel: true });
    expect((await app.inject({ method: "POST", url: `/settings/models/providers/${local.id}/models/custom`, payload: { ...firstModel, api: "anthropic-messages" } })).statusCode).toBe(201);
    expect(await runtime.getAvailable(local.id)).toContainEqual(expect.objectContaining({ id: firstModel.id, api: "anthropic-messages" }));
    const providers = (await app.inject({ method: "GET", url: "/settings/providers" })).json();
    expect(providers).toContainEqual(expect.objectContaining({ id: keyed.id, name: gateway.name, custom: true, configured: true, enabled: true }));
    for (const url of ["/settings/providers", "/models", `/settings/models/providers/${keyed.id}/custom`, `/settings/models/providers/${keyed.id}/models`]) expect((await app.inject({ method: "GET", url })).body).not.toContain(gateway.apiKey);
    expect(await readFile(path.join(directory, "models.json"), "utf8")).not.toContain(gateway.apiKey);
    expect(await readFile(path.join(directory, "model-visibility.json"), "utf8")).not.toContain(gateway.apiKey);
    expect(await readFile(path.join(directory, "auth.json"), "utf8")).toContain(gateway.apiKey);
  });

  it("preserves identity, models and key when editing; protects builtins and deletes custom settings", async () => {
    const { runtime, app, create } = await fixture();
    const { id } = await create();
    const changed = { name: "Renamed gateway", api: "openai-responses", baseUrl: "https://new.example/v1", authentication: "api_key" };
    const update = await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/custom`, payload: changed });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json()).toEqual({ id, ...changed, models: [{ ...firstModel, api: changed.api }], hiddenModelIds: [] });
    expect(runtime.getModel(id, firstModel.id)).toMatchObject({ api: changed.api, baseUrl: changed.baseUrl });
    expect((await runtime.getAuth(id))?.auth?.apiKey).toBe(gateway.apiKey);
    expect((await app.inject({ method: "PUT", url: "/settings/models/providers/openai/custom", payload: changed })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/settings/models/providers/openai/custom" })).statusCode).toBe(404);
    const removed = await app.inject({ method: "DELETE", url: `/settings/models/providers/${id}/custom` });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(runtime.getProvider(id)).toBeUndefined();
    expect((await runtime.listCredentials()).some((credential) => credential.providerId === id)).toBe(false);
    expect((await app.inject({ method: "GET", url: `/settings/models/providers/${id}/custom` })).statusCode).toBe(404);
  });

  it("removes models through the provider editor, pruning visibility while retaining other definitions and credentials", async () => {
    const { directory, runtime, app, create } = await fixture();
    const { id } = await create();
    const second = { ...firstModel, id: "second-model", name: "Second model" };
    const url = `/settings/models/providers/${id}/custom`;
    const payload = { ...gateway, apiKey: undefined, models: [firstModel, second], hiddenModelIds: [firstModel.id] };
    expect((await app.inject({ method: "PUT", url, payload })).statusCode).toBe(200);
    const removed = await app.inject({ method: "PUT", url, payload: { ...payload, models: [second], hiddenModelIds: [] } });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ models: [second], hiddenModelIds: [] });
    expect(runtime.getModels(id)).toHaveLength(1);
    expect(runtime.getModel(id, firstModel.id)).toBeUndefined();
    expect((await runtime.getAuth(id))?.auth?.apiKey).toBe(gateway.apiKey);
    expect(JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8")).hidden[id]).toEqual([]);
    const empty = await app.inject({ method: "PUT", url, payload: { ...payload, models: [], hiddenModelIds: [] } });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ models: [], hiddenModelIds: [] });
    expect(runtime.getModels(id)).toEqual([]);
    expect(runtime.hasConfiguredAuth(id)).toBe(true);
  });

  it("persists enable state, retains hidden models and rejects new requests using a cached session", async () => {
    const { directory, runtime, app, create, prompt } = await fixture();
    const { id } = await create();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Provider test" } })).json();
    const model = { provider: id, id: firstModel.id };
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: { model } })).json();
    const base = `/projects/${project.id}/conversations/${conversation.id}`;
    expect((await app.inject({ method: "POST", url: `${base}/turns`, payload: { prompt: "First" } })).statusCode).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    await app.inject({ method: "PUT", url: `/settings/models/providers/${id}/models/visibility`, payload: { ids: [firstModel.id], visible: false } });
    expect((await app.inject({ method: "PATCH", url: `/settings/models/providers/${id}/enabled`, payload: { enabled: false } })).statusCode).toBe(200);
    const catalog = (await app.inject({ method: "GET", url: "/models" })).json();
    expect([...catalog.models, ...catalog.hiddenModels ?? []].some((item: { provider: string }) => item.provider === id)).toBe(false);
    for (const [url, payload] of [[`${base}/turns`, { prompt: "Second" }], [`${base}/compact`, {}], [`${base}/plan/approve`, {}], [`${base}/revise-last`, { prompt: "Changed" }]] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toContain("disabled");
    }
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model, reasoningLevel: "off" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/text/generate`, payload: { model, instruction: "Write" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: { model } })).statusCode).toBe(400);
    expect(prompt).toHaveBeenCalledOnce();
    const restored = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(restored);
    expect((await restored.inject({ method: "GET", url: "/settings/providers" })).json()).toContainEqual(expect.objectContaining({ id, enabled: false, configured: true }));
    await app.inject({ method: "PATCH", url: `/settings/models/providers/${id}/enabled`, payload: { enabled: true } });
    expect((await app.inject({ method: "GET", url: "/models" })).json().hiddenModels).toContainEqual(expect.objectContaining({ provider: id, id: firstModel.id }));
    expect((await runtime.getAuth(id))?.auth?.apiKey).toBe(gateway.apiKey);
  });

  it("rolls back failed saves and keeps JSONC comments and unrelated configuration", async () => {
    const { directory } = await fixture();
    const store = new ProviderModelSettingsStore(directory, directory);
    const original = '{\n // Preserve me\n "providers": {"other": {"baseUrl": "https://other.example/v1"}}\n}\n';
    await writeFile(path.join(directory, "models.json"), original);
    await expect(store.saveCustomProvider("custom-test", gateway, async () => { throw new Error("Credential write failed"); })).rejects.toThrow("Credential write failed");
    expect(await readFile(path.join(directory, "models.json"), "utf8")).toBe(original);
    expect(store.isCustom("custom-test")).toBe(false);
    await store.saveCustomProvider("custom-test", gateway, async () => {});
    const contents = await readFile(path.join(directory, "models.json"), "utf8");
    expect(contents).toContain("// Preserve me");
    expect(contents).toContain("https://other.example/v1");
    const invalid = { ...gateway, baseUrl: "https://user:secret@example.com/v1" };
    const app = apps.at(-1)!;
    expect((await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: invalid })).statusCode).toBe(400);
  });

  it("lets an in-flight request finish while refusing subsequent prompts", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const { app, create, prompt, abort } = await fixture(vi.fn(async () => completion));
    const { id } = await create();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: { model: { provider: id, id: firstModel.id } } })).json();
    const url = `/projects/${project.id}/conversations/${conversation.id}/turns`;
    try {
      expect((await app.inject({ method: "POST", url, payload: { prompt: "Running" } })).statusCode).toBe(202);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      await app.inject({ method: "PATCH", url: `/settings/models/providers/${id}/enabled`, payload: { enabled: false } });
      expect(abort).not.toHaveBeenCalled();
      expect((await app.inject({ method: "POST", url, payload: { prompt: "Next" } })).statusCode).toBe(409);
    } finally { finish(); }
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/projects/activity" })).json()).toEqual([]));
  });

  it("excludes disabled media providers without issuing network requests", async () => {
    const { runtime } = await fixture();
    const request = vi.fn<typeof fetch>();
    const images = new ProviderImages(async () => runtime, request, () => "test-ark-key", () => false);
    const videos = new ProviderVideos(async () => runtime, request, () => "test-seedance-key", () => false);
    expect(await images.catalog()).toEqual({ models: [], providers: [] });
    expect(await videos.catalog()).toEqual({ models: [], providers: [] });
    await expect(images.generate({ prompt: "Image", imageModel: { provider: "openai", id: "gpt-image-1" } })).rejects.toThrow("disabled");
    await expect(videos.generate({ prompt: "Video", model: { provider: "openrouter", id: "video" } })).rejects.toThrow("disabled");
    await expect(images.generate({ prompt: "Image", imageModel: { provider: "volcengine-ark", id: "seedream" } })).rejects.toThrow("disabled");
    await expect(videos.generate({ prompt: "Video", model: { provider: "byteplus-modelark", id: "seedance" } })).rejects.toThrow("disabled");
    const meshy = new MeshyProvider(() => "test-key", request, undefined, () => false);
    await expect(meshy.animations()).rejects.toThrow("disabled");
    expect(request).not.toHaveBeenCalled();
  });
});
