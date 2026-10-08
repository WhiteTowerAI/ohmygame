import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
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

async function fixture(prompt = vi.fn(async () => {}), modelDiscoveryFetch?: typeof fetch) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-custom-providers-"));
  directories.push(directory);
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
  const abort = vi.fn(async () => {});
  const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, modelDiscoveryFetch, createModelRuntime: async () => runtime, createSession: async () => ({ messages: [], prompt, abort, dispose: () => {}, subscribe: () => () => {} }) });
  apps.push(app);
  const create = async (payload = gateway) => {
    const result = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload });
    expect(result.statusCode, result.body).toBe(201);
    return result.json() as { id: string };
  };
  return { directory, runtime, app, create, prompt, abort };
}

describe("custom providers", () => {
  it("passes canvas text and document reasoning to the runtime, uses defaults, and rejects unsupported levels", async () => {
    const { runtime, app, create } = await fixture();
    const { id } = await create({ ...gateway, models: [{ ...firstModel, reasoning: true }] });
    const model = { provider: id, id: firstModel.id };
    const message = { role: "assistant", content: [{ type: "text", text: "Generated rules" }], stopReason: "stop" } as Awaited<ReturnType<typeof runtime.completeSimple>>;
    const complete = vi.spyOn(runtime, "completeSimple").mockResolvedValue(message);
    const stream = vi.spyOn(runtime, "streamSimple").mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
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
      expect(url === documentUrl ? stream : complete).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ reasoning: "high" }));
      const calls = { complete: complete.mock.calls.length, stream: stream.mock.calls.length };
      for (const reasoningLevel of ["max", "turbo"]) {
        const rejected = await app.inject({ method: "POST", url, payload: { instruction: "Write rules", model, reasoningLevel, ...extra } });
        expect(rejected.statusCode, rejected.body).toBe(400);
      }
      expect(complete).toHaveBeenCalledTimes(calls.complete);
      expect(stream).toHaveBeenCalledTimes(calls.stream);
    }
    expect((await app.inject({ method: "PUT", url: "/models/default", payload: { model, reasoningLevel: "high" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: textUrl, payload: { instruction: "Write rules" } })).statusCode).toBe(200);
    expect(complete.mock.lastCall?.[2]?.reasoning).toBe("high");
    expect((await app.inject({ method: "POST", url: textUrl, payload: { instruction: "Write rules", model, reasoningLevel: "off" } })).statusCode).toBe(200);
    expect(complete.mock.lastCall?.[2]).not.toHaveProperty("reasoning");
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
    const saved = await app.inject({ method: "POST", url: "/settings/models/providers/custom", payload: { ...gateway, models: [models[0], models[2]] } });
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
