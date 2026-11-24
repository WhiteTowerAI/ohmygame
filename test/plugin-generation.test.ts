import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import { PluginGeneration, PluginGenerationError, type PluginGenerationOptions } from "../src/daemon/plugin-generation.js";
import { ToolRunError } from "../src/daemon/tools.js";
import type { ProjectState, ToolRun } from "../src/shared/contracts.js";
import { readPluginGenerationRequest } from "../src/shared/plugin-generation.js";
import { pluginUiRefusal, readPluginUiRequest } from "../src/shared/plugin-ui-protocol.js";

const read = (value: unknown) => {
  const result = readPluginGenerationRequest(value);
  if (!result.ok) throw new Error(result.error);
  return result.request;
};

describe("plugin generation requests", () => {
  it("reads only what an image or audio request can take", () => {
    expect(read({ media: "image", prompt: "A spark", aspectRatio: "16:9", transparentBackground: true, images: [{ data: "aGk=", type: "image/png" }] }))
      .toEqual({ media: "image", prompt: "A spark", aspectRatio: "16:9", transparentBackground: true, images: [{ data: "aGk=", type: "image/png" }] });
    expect(read({ media: "audio", prompt: "A zap", kind: "sound-effect", durationSeconds: 1, model: { provider: "eleven", id: "sfx" } }))
      .toEqual({ media: "audio", prompt: "A zap", kind: "sound-effect", durationSeconds: 1, model: { provider: "eleven", id: "sfx" } });
    for (const [value, error] of [
      [{ media: "video", prompt: "x" }, "media is image or audio"],
      [{ media: "image", prompt: " " }, "prompt is text"],
      [{ media: "image", prompt: "x", kind: "music" }, "An image request has no kind"],
      [{ media: "audio", prompt: "x", aspectRatio: "1:1" }, "An audio request has no aspectRatio"],
      [{ media: "image", prompt: "x", aspectRatio: "7:5" }, "aspectRatio is"],
      [{ media: "image", prompt: "x", outputs: 2 }, "give an aspectRatio or a resolution"],
      [{ media: "image", prompt: "x", aspectRatio: "1:1", images: [{ data: "aGk=", type: "image/gif" }] }, "image/png, image/jpeg or image/webp"],
      [{ media: "audio", prompt: "x", voiceId: "a b" }, "voiceId"],
      [{ media: "audio", prompt: "x", durationSeconds: 0 }, "durationSeconds"],
    ] as const) expect(readPluginGenerationRequest(value)).toEqual({ ok: false, error: expect.stringContaining(error) });
  });

  it("needs the media capability for a page's requests, and the call that cancels it", () => {
    expect(pluginUiRefusal("media.generate", { models: true })).toContain("media");
    expect(pluginUiRefusal("media.generate", { media: true })).toBeUndefined();
    expect(readPluginUiRequest({ id: 1, method: "media.generate", params: { media: "image", prompt: "x" } })).toMatchObject({ ok: false, error: expect.stringContaining("call") });
    expect(readPluginUiRequest({ id: 2, method: "media.models", params: { media: "image", kind: "music" } })).toMatchObject({ ok: false });
    expect(readPluginUiRequest({ id: 3, method: "media.models", params: { media: "audio", kind: "music" } })).toMatchObject({ ok: true });
  });
});

function service(run: PluginGenerationOptions["tools"]["run"]) {
  const logs: string[] = [];
  const removed: string[] = [];
  const tools = {
    run: vi.fn(run),
    file: vi.fn(async (_run: string, name: string) => ({ bytes: Buffer.from(name), mediaType: name.endsWith(".mp3") ? "audio/mpeg" : "image/png", assetId: `asset-${name}` })),
    removeRun: vi.fn(async (id: string) => { removed.push(id); }),
  };
  const generation = new PluginGeneration({ tools, models: async () => ({ models: [] }), log: (plugin, text) => logs.push(`${plugin}: ${text}`) });
  return { generation, tools, logs, removed };
}

const toolRun = (files: ToolRun["files"]): ToolRun => ({ id: "run-1", toolId: "generate-image", createdAt: "", files, model: { provider: "acme", id: "pix" } });

describe("plugin generation", () => {
  it("makes what a plugin asks the way the app does, gives back its files and keeps only the Library's copy", async () => {
    const { generation, tools, logs, removed } = service(async () => toolRun([{ name: "output-1.png", mediaType: "image/png" }, { name: "output-2.png", mediaType: "image/png" }]));
    const result = await generation.generate("acme/fx", "project-1", read({ media: "image", prompt: "A spark", model: { provider: "acme", id: "pix" }, aspectRatio: "1:1", outputs: 2, images: [{ data: "aGk=", type: "image/png" }] }), new AbortController().signal);
    expect(tools.run).toHaveBeenCalledWith("generate-image", {
      prompt: "A spark", imageModel: { provider: "acme", id: "pix" }, aspectRatio: "1:1", outputs: 2, images: [{ mediaType: "image/png", data: "aGk=" }],
    }, expect.any(AbortSignal), "project-1", { addedBy: "acme/fx" });
    expect(result).toEqual({ model: { provider: "acme", id: "pix" }, files: [
      { name: "output-1.png", type: "image/png", data: Buffer.from("output-1.png").toString("base64"), assetId: "asset-output-1.png" },
      { name: "output-2.png", type: "image/png", data: Buffer.from("output-2.png").toString("base64"), assetId: "asset-output-2.png" },
    ] });
    expect(removed).toEqual(["run-1"]);
    expect(logs).toEqual(["acme/fx: Made 2 images with acme/pix"]);
  });

  it("gives back an audio run's sound without its subtitles", async () => {
    const { generation, tools, logs } = service(async () => toolRun([{ name: "output.mp3", mediaType: "audio/mpeg", role: "audio" }, { name: "output.srt", mediaType: "text/plain", role: "subtitles" }]));
    const result = await generation.generate("acme/fx", "project-1", read({ media: "audio", prompt: "Hello", kind: "speech" }), new AbortController().signal);
    expect(tools.run).toHaveBeenCalledWith("generate-audio", { prompt: "Hello", kind: "speech" }, expect.any(AbortSignal), "project-1", { addedBy: "acme/fx" });
    expect(result.files.map((file) => file.name)).toEqual(["output.mp3"]);
    expect(logs).toEqual(["acme/fx: Made audio with acme/pix"]);
  });

  it("says why it failed, and lets a plugin make a few at a time and so many a minute", async () => {
    const failing = service(async () => { throw new ToolRunError("No image model is available.", 503); });
    await expect(failing.generation.generate("acme/fx", "p", read({ media: "image", prompt: "x" }), new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 503, message: "No image model is available." });
    expect(failing.logs).toEqual(["acme/fx: Making an image: failed: No image model is available."]);
    expect(failing.removed).toEqual([]);

    const waiting: Array<() => void> = [];
    const { generation } = service((_tool, _input, signal) => new Promise<ToolRun>((resolve, reject) => {
      waiting.push(() => resolve(toolRun([])));
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const stop = new AbortController();
    const first = generation.generate("acme/fx", "p", read({ media: "image", prompt: "x" }), stop.signal);
    const second = generation.generate("acme/fx", "p", read({ media: "image", prompt: "x" }), new AbortController().signal);
    await expect(generation.generate("acme/fx", "p", read({ media: "image", prompt: "x" }), new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 429, message: expect.stringContaining("at once") });
    // Another plugin isn't held back by this one.
    const other = generation.generate("acme/other", "p", read({ media: "image", prompt: "x" }), new AbortController().signal);
    stop.abort();
    await expect(first).rejects.toEqual(new PluginGenerationError("Cancelled", 409));
    waiting[1]!();
    waiting[2]!();
    await expect(second).resolves.toEqual({ model: { provider: "acme", id: "pix" }, files: [] });
    await other;
    for (let index = 0; index < 8; index++) {
      const made = generation.generate("acme/fx", "p", read({ media: "image", prompt: "x" }), new AbortController().signal);
      waiting.at(-1)!();
      await made;
    }
    await expect(generation.generate("acme/fx", "p", read({ media: "image", prompt: "x" }), new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 429, message: expect.stringContaining("a minute") });
  });
});

describe("plugin generation routes", () => {
  const directories: string[] = [];
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function setup(capabilities: Record<string, unknown>) {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-generation-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-generation-source-"));
    directories.push(dataDirectory, source);
    const generate = vi.fn<ImageGenerator["generate"]>(async () => ({ bytes: Buffer.from("spark"), mediaType: "image/webp" }));
    const app = createApp({ dataDirectory, imageGenerator: { generate } });
    apps.push(app);
    await app.ready();
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(source, "ui"), { recursive: true });
    await writeFile(path.join(source, "ui/panel.html"), "<p>panel</p>");
    await writeFile(path.join(source, "ui/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify({
      id: "acme/fx", version: "1.0.0", engines: { "ohmygame-api": "^2.38.0" }, displayName: "Effects", description: "Makes effects.", icon: "./ui/icon.svg",
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
    return { app, base: `/projects/${project.id}/plugin-media/acme/fx`, generate };
  }

  it("makes an image for a page that asks for media, keeps it in the Library under the plugin, and writes it in the log", async () => {
    const { app, base, generate } = await setup({ media: true });
    expect((await app.inject({ method: "GET", url: `${base}?media=image` })).json()).toEqual({ models: [] });
    // It writes nothing in the project, so it never waits for the workspace or fails for an old version of it.
    const made = await app.inject({ method: "POST", url: `${base}/generate`, headers: { "x-workspace-version": "stale" }, payload: { media: "image", prompt: "A spark" } });
    expect(made.statusCode, made.body).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    const { files } = made.json<{ files: Array<{ name: string; type: string; data: string; assetId: string }> }>();
    expect(files).toEqual([{ name: "output.webp", type: "image/webp", data: Buffer.from("spark").toString("base64"), assetId: expect.any(String) }]);
    const assets = (await app.inject({ method: "GET", url: "/library/assets" })).json<Array<{ id: string; addedBy?: string; prompt?: string }>>();
    expect(assets.find((asset) => asset.id === files[0]!.assetId)).toMatchObject({ addedBy: "acme/fx", prompt: "A spark" });
    expect((await app.inject({ method: "POST", url: `${base}/generate`, payload: { media: "image" } })).statusCode).toBe(400);
    const log = (await app.inject({ method: "GET", url: "/plugin-store/acme/fx/log" })).json<{ entries: Array<{ text: string }> }>();
    expect(log.entries.map((entry) => entry.text)).toContain("Made 1 image");
  });

  it("refuses a Plugin Builder preview, whose spending the person hasn't agreed to", async () => {
    const { app, base, generate } = await setup({ media: true });
    const draft = base.replace("/acme/fx", "/_draft/abc");
    const refused = await app.inject({ method: "POST", url: `${draft}/generate`, payload: { media: "image", prompt: "x" } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain("Plugin Builder");
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a plugin that didn't ask for media", async () => {
    const { app, base, generate } = await setup({ models: true });
    expect((await app.inject({ method: "GET", url: `${base}?media=image` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/generate`, payload: { media: "image", prompt: "x" } })).statusCode).toBe(403);
    expect(generate).not.toHaveBeenCalled();
  });
});
