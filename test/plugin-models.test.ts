import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { RuntimeModel } from "../src/daemon/agent.js";
import { PluginModelError, PluginModels } from "../src/daemon/plugin-models.js";
import { PLUGIN_MODEL_LIMITS, readPluginModelRequest } from "../src/shared/plugin-models.js";
import { pluginUiRefusal, readPluginUiRequest } from "../src/shared/plugin-ui-protocol.js";
import type { ProjectState } from "../src/shared/contracts.js";

const model = (id: string, images = false): RuntimeModel => ({
  provider: "openai", id, name: id.toUpperCase(), api: "openai-completions", baseUrl: "https://fixture.example/v1",
  reasoning: false, input: images ? ["text", "image"] : ["text"], contextWindow: 128_000, maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const FAST = model("fast");
const VISION = model("vision", true);

type Response = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
const answer = (text: string, stopReason: Response["stopReason"] = "stop", extra: Partial<Response> = {}) =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason, usage: { input: 12, output: 5 }, ...extra }) as unknown as Response;

function service(complete: ModelRuntime["completeSimple"], defaults: { provider: string; id: string } | null = { provider: "openai", id: "vision" }, available = [FAST, VISION]) {
  const completeSimple = vi.fn(complete);
  const logs: string[] = [];
  let now = 0;
  const models = new PluginModels({
    runtime: async () => ({ completeSimple }) as unknown as ModelRuntime,
    models: async () => available,
    defaultModel: () => defaults ?? undefined,
    log: (plugin, text) => logs.push(`${plugin}: ${text}`),
    now: () => now,
  });
  return { models, completeSimple, logs, advance: (ms: number) => { now += ms; } };
}

const ask = (text: string, extra: Record<string, unknown> = {}) => {
  const read = readPluginModelRequest({ messages: [{ role: "user", text }], ...extra });
  if (!read.ok) throw new Error(read.error);
  return read.request;
};

describe("plugin model requests", () => {
  it("reads only requests a model can take", () => {
    expect(readPluginModelRequest({ system: "Be brief", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }, { role: "user", text: "more", images: [{ data: "aGk=", type: "image/png" }] }], json: true, maxTokens: 100, model: { provider: "openai", id: "fast" } }))
      .toEqual({ ok: true, request: { system: "Be brief", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }, { role: "user", text: "more", images: [{ data: "aGk=", type: "image/png" }] }], json: true, maxTokens: 100, model: { provider: "openai", id: "fast" } } });
    for (const [value, error] of [
      [{ messages: [] }, "1 to 40"],
      [{ messages: [{ role: "assistant", text: "hi" }] }, "the last message is the user's"],
      [{ messages: [{ role: "system", text: "hi" }] }, "user or assistant"],
      [{ messages: [{ role: "assistant", text: "x", images: [] }, { role: "user", text: "y" }] }, "has no images"],
      [{ messages: [{ role: "user", text: "x", images: [{ data: "aGk=", type: "image/svg+xml" }] }] }, "image/png"],
      [{ messages: [{ role: "user", text: "x", images: [{ data: "not base64!", type: "image/png" }] }] }, "base64"],
      [{ messages: [{ role: "user", text: "  " }] }, "no text or images"],
      [{ messages: [{ role: "user", text: "x".repeat(PLUGIN_MODEL_LIMITS.textChars + 1) }] }, "200,000"],
      [{ messages: [{ role: "user", text: "x" }], maxTokens: 9_000 }, "maxTokens"],
      [{ messages: [{ role: "user", text: "x" }], model: { provider: "openai" } }, "models.list"],
    ] as const) expect(readPluginModelRequest(value), JSON.stringify(value).slice(0, 80)).toMatchObject({ ok: false, error: expect.stringContaining(error) });
  });

  it("asks the default or chosen model, reads JSON, and logs what each request used", async () => {
    const { models, completeSimple, logs } = service(async () => answer("```json\n{\"burst\":true}\n```"));
    expect(await models.list()).toEqual([
      { provider: "openai", id: "fast", name: "FAST", images: false },
      { provider: "openai", id: "vision", name: "VISION", images: true, default: true },
    ]);
    const result = await models.complete("acme/fx", undefined, ask("A burst", { json: true, system: "Make effects" }));
    expect(result).toEqual({ text: "```json\n{\"burst\":true}\n```", json: { burst: true }, model: { provider: "openai", id: "vision" }, usage: { input: 12, output: 5 }, stopReason: "stop" });
    const [used, context, options] = completeSimple.mock.calls[0]!;
    expect(used).toBe(VISION);
    expect(context.systemPrompt).toContain("Make effects");
    expect(context.systemPrompt).toContain("JSON only");
    expect(options).toMatchObject({ maxTokens: PLUGIN_MODEL_LIMITS.defaultMaxTokens, maxRetries: 0 });
    expect(logs).toEqual(["acme/fx: Asked openai/vision: 12 tokens in, 5 out"]);

    await models.complete("acme/fx", undefined, ask("Look", { model: { provider: "openai", id: "fast" }, maxTokens: 4_000 }));
    expect(completeSimple.mock.calls[1]![0]).toBe(FAST);
    // Without a default it is one of them, the first, as the app's own pickers do.
    const unset = service(async () => answer("x"), null);
    expect((await unset.models.list())[0]).toMatchObject({ id: "fast", default: true });
    await expect(unset.models.complete("acme/fx", undefined, ask("x"))).resolves.toMatchObject({ model: { id: "fast" } });
  });

  it("refuses what it can't answer, and says why the model didn't", async () => {
    const { models } = service(async () => answer("not json"), { provider: "openai", id: "fast" });
    await expect(models.complete("acme/fx", undefined, ask("x", { json: true }))).rejects.toThrow("isn't JSON");
    const imageRequest = readPluginModelRequest({ messages: [{ role: "user", text: "x", images: [{ data: "aGk=", type: "image/png" }] }] });
    if (!imageRequest.ok) throw new Error(imageRequest.error);
    await expect(models.complete("acme/fx", undefined, imageRequest.request)).rejects.toThrow("doesn't read images");
    await expect(models.complete("acme/fx", undefined, ask("x", { model: { provider: "openai", id: "gone" } }))).rejects.toMatchObject({ statusCode: 409 });
    const failing = service(async () => answer("", "error", { errorMessage: "quota exceeded" }));
    await expect(failing.models.complete("acme/fx", undefined, ask("x"))).rejects.toMatchObject({ message: "quota exceeded", statusCode: 502 });
    const none = service(async () => answer("x"), null, []);
    await expect(none.models.complete("acme/fx", undefined, ask("x"))).rejects.toThrow("No language model is set up");
    const throwing = service(async () => { throw new Error("socket hang up"); });
    await expect(throwing.models.complete("acme/fx", undefined, ask("x"))).rejects.toMatchObject({ message: "socket hang up", statusCode: 502 });
    expect(throwing.logs).toEqual(["acme/fx: Asked openai/vision: failed"]);
  });

  it("lets a plugin run a few at a time and so many a minute, and stops one it gives up on", async () => {
    const waiting: Array<() => void> = [];
    const { models, advance } = service((_model, _context, options) => new Promise((resolve) => {
      options?.signal?.addEventListener("abort", () => resolve(answer("", "aborted")), { once: true });
      waiting.push(() => resolve(answer("done")));
    }));
    // Refused before it reaches a model, which doesn't count.
    for (let index = 0; index < 40; index++)
      await expect(models.complete("acme/fx", undefined, ask("x", { model: { provider: "openai", id: "gone" } }))).rejects.toMatchObject({ statusCode: 409 });
    const running = [0, 1, 2].map(() => models.complete("acme/fx", undefined, ask("x")));
    await vi.waitFor(() => expect(waiting).toHaveLength(3));
    await expect(models.complete("acme/fx", undefined, ask("x"))).rejects.toMatchObject({ statusCode: 429 });
    // Another plugin has its own.
    const other = new AbortController();
    const stopped = models.complete("acme/other", undefined, ask("x"), other.signal);
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    other.abort();
    await expect(stopped).rejects.toMatchObject({ message: "Cancelled" });
    for (const finish of waiting.splice(0, 3)) finish();
    await Promise.all(running);
    // The one given up on already answered.
    waiting.length = 0;
    for (let index = 3; index < PLUGIN_MODEL_LIMITS.perMinute; index++) {
      const call = models.complete("acme/fx", undefined, ask("x"));
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()!();
      await call;
    }
    await expect(models.complete("acme/fx", undefined, ask("x"))).rejects.toThrow("30 times a minute");
    advance(60_000);
    const later = models.complete("acme/fx", undefined, ask("x"));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()!();
    await expect(later).resolves.toMatchObject({ text: "done" });
    expect(PluginModelError).toBeDefined();
  });

  it("needs the models capability for a page's requests, which may carry long text", () => {
    expect(pluginUiRefusal("models.complete", {})).toBe("models.complete needs the models capability");
    expect(pluginUiRefusal("models.list", { models: true })).toBeUndefined();
    const long = readPluginUiRequest({ id: 1, method: "models.complete", params: { messages: [{ role: "user", text: "x".repeat(500_000) }], call: "call-1" } });
    expect(long.ok).toBe(true);
    expect(readPluginUiRequest({ id: 2, method: "models.complete", params: { messages: [{ role: "user", text: "x", images: [{ data: 3 }] }] } })).toMatchObject({ ok: false, error: expect.stringContaining("Blob") });
    expect(readPluginUiRequest({ id: 3, method: "models.cancel", params: {} })).toMatchObject({ ok: false });
  });
});

describe("plugin model routes", () => {
  const directories: string[] = [];
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function setup(capabilities: Record<string, unknown>) {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-models-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-models-source-"));
    directories.push(dataDirectory, source);
    const completeSimple = vi.fn<ModelRuntime["completeSimple"]>().mockResolvedValue(answer("A spark"));
    const runtime = {
      getAvailable: async () => [FAST],
      getModels: () => [FAST],
      getProvider: () => ({ name: "OpenAI" }),
      hasConfiguredAuth: () => true,
      completeSimple,
      refresh: async () => {},
    } as unknown as ModelRuntime;
    const app = createApp({ dataDirectory, createModelRuntime: async () => runtime });
    apps.push(app);
    await app.ready();
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(source, "ui"), { recursive: true });
    await writeFile(path.join(source, "ui/panel.html"), "<p>panel</p>");
    await writeFile(path.join(source, "ui/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify({
      id: "acme/fx", version: "1.0.0", engines: { "ohmygame-api": "^2.35.0" }, displayName: "Effects", description: "Makes effects.", icon: "./ui/icon.svg",
      capabilities,
      contributes: { panels: [{ id: "main", title: "Main", area: "right", entry: "./ui/panel.html" }] },
    }));
    const payload = { source: { type: "directory", path: source } };
    const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
    expect(inspected.statusCode, inspected.body).toBe(200);
    const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
    expect(added.statusCode, added.body).toBe(201);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Effects" } })).json<ProjectState>();
    const on = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/fx`, payload: { on: true, version: "1.0.0" } });
    expect(on.statusCode, on.body).toBe(204);
    return { app, base: `/projects/${project.id}/plugin-models/acme/fx`, completeSimple };
  }

  it("lists and asks the person's models for a page that asks for them, writing what it used in the plugin's log", async () => {
    const { app, base, completeSimple } = await setup({ models: true });
    const listed = await app.inject({ method: "GET", url: base });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({ models: [{ provider: "openai", id: "fast", name: "FAST", images: false, default: true }] });
    const asked = await app.inject({ method: "POST", url: `${base}/complete`, payload: { messages: [{ role: "user", text: "A spark" }], model: { provider: "openai", id: "fast" } } });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ text: "A spark", usage: { input: 12, output: 5 } });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    // Without a default model set up, the first one answers.
    expect((await app.inject({ method: "POST", url: `${base}/complete`, payload: { messages: [{ role: "user", text: "x" }] } })).json()).toMatchObject({ model: { provider: "openai", id: "fast" } });
    expect((await app.inject({ method: "POST", url: `${base}/complete`, payload: { messages: [] } })).statusCode).toBe(400);
    const log = (await app.inject({ method: "GET", url: "/plugin-store/acme/fx/log" })).json<{ entries: Array<{ text: string }> }>();
    expect(log.entries.filter((entry) => entry.text === "Asked openai/fast: 12 tokens in, 5 out")).toHaveLength(2);
  });

  it("refuses a plugin that didn't ask for models", async () => {
    const { app, base, completeSimple } = await setup({ composer: true });
    expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/complete`, payload: { messages: [{ role: "user", text: "x" }] } })).statusCode).toBe(403);
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
