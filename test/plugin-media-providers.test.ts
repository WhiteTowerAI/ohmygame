import { CanvasStore, readCanvasJobHistory } from "../src/daemon/canvas-workspace.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import { fork } from "node:child_process";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import Fastify from "fastify";
import { ProjectManager } from "../src/daemon/projects.js";
import { registerCanvasRoutes } from "../src/daemon/canvas-routes.js";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMediaModels } from "../src/shared/plugin-manifest.js";
import type { ImageModel, VideoModel } from "../src/shared/contracts.js";
import { GenerationShutdown, inspectMediaTaskJournal, mediaTaskJournal } from "../src/daemon/media-task-journal.js";
import { MediaTaskReuse } from "../src/daemon/media-task-reuse.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import { PluginMediaModelChoices } from "../src/daemon/plugin-media-models.js";
import { MediaInputFiles } from "../src/daemon/plugin-media-files.js";
import { runMediaAdapter } from "../src/daemon/plugin-media-sandbox.js";
import { PluginMediaProviders } from "../src/daemon/plugin-media-providers.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";
import { ProviderAudio } from "../src/daemon/audio-generation.js";
import { readEncodedAudio } from "../src/daemon/plugin-audio-response.js";
import { PluginValues } from "../src/daemon/plugin-values.js";
import { TEST_GLB, model3DFixture } from "./model3d-fixture.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { ProviderModels3D } from "../src/daemon/provider-models3d.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypisom"), Buffer.alloc(16)]);

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ohmygame-media-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

type Media = NonNullable<NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number]["media"]>;

type Reply = (url: string, signal: AbortSignal | null | undefined) => Response | undefined | Promise<Response | undefined>;

async function setup(adapter: string, options: { digest?: string; key?: string | undefined; media?: Partial<Media>; network?: string[]; allowed?: boolean; reply?: Reply; choices?: PluginMediaModelChoices; values?: PluginValues; configuration?: PluginIndexEntry["manifest"]["configuration"] } = {}) {
  await writeFile(path.join(root, "media.js"), adapter);
  const entry = {
    id: "acme/flow", version: "1.0.0", root, digest: options.digest ?? "d1", strings: { en: { provider: "Flow" } }, skills: [], toolSchemas: {},
    manifest: {
      id: "acme/flow", version: "1.0.0", displayName: "Flow", description: "Flow",
      configuration: { apiKey: { type: "secret", title: "Key" }, ...options.configuration },
      capabilities: { network: options.network ?? ["api.flow.example", "cdn.flow.example"] },
      contributes: { providers: [{
        id: "flow", title: "%provider%", apiKey: "apiKey",
        media: { adapter: "./media.js", image: { models: [{ id: "kolors", title: "Kolors", resolutions: ["1K"], aspectRatios: ["1:1", "16:9"], maxReferenceImages: 1 }] }, ...options.media },
      }] },
    },
  } as unknown as PluginIndexEntry;
  const key = "key" in options ? options.key : "sk-test";
  // Only plugins whose capabilities the person allowed are in `everyProject`.
  const services = { everyProject: async () => options.allowed === false ? [] : [entry], values: options.values ?? { secret: () => key } } as unknown as PluginServices;
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string; form?: FormData }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(typeof init?.body === "string" ? { body: init.body } : init?.body instanceof FormData ? { form: init.body } : {}) });
    const reply = await options.reply?.(url, init?.signal);
    if (reply) return reply;
    if (url.startsWith("https://cdn.flow.example/") && url.endsWith(".mp4")) return new Response(MP4, { headers: { "content-type": "video/mp4" } });
    if (url.startsWith("https://cdn.flow.example/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return new Response(JSON.stringify({ url: "https://cdn.flow.example/one.png", id: "t1" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { media: new PluginMediaProviders(services, fetcher, undefined, options.choices, root), requests, entry };
}

const firstModel = async (media: PluginMediaProviders): Promise<ImageModel> => (await media.imageProviders())[0]!.models[0]!;

const IMAGE_START = `export default { image: { async start(input, host) {
  const answer = await (await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true, json: { model: input.model, prompt: input.prompt, ratio: input.aspectRatio, refs: input.references.length } })).json();
  return { outputs: [{ url: answer.url }] };
} } };`;

describe("plugin media providers", () => {
  it("lists a provider's image models once its key is set", async () => {
    const { media } = await setup(IMAGE_START);
    expect(await media.imageProviders()).toEqual([{ id: "plugin.acme.flow.flow", name: "Flow", models: [expect.objectContaining({
      provider: "plugin.acme.flow.flow", providerName: "Flow", id: "kolors", name: "Kolors", protocol: "plugin", sizes: [],
      generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }, { resolution: "1K", aspectRatio: "16:9" }],
      supportsReferenceImage: true, maxReferenceImages: 1, maxOutputs: 1,
    })] }]);
    expect(await (await setup(IMAGE_START, { key: undefined })).media.imageProviders()).toEqual([]);
  });

  it("makes a picture through the adapter, adding the key where it asks, and downloads the result", async () => {
    const { media, requests } = await setup(IMAGE_START);
    const model = await firstModel(media);
    const image = await media.generateImage(model, { prompt: "a fox", aspectRatio: "16:9", images: [{ mediaType: "image/png", data: PNG.toString("base64") }] });
    expect(image).toEqual({ bytes: PNG, mediaType: "image/png" });
    expect(requests[0]).toMatchObject({ url: "https://api.flow.example/v1/images", method: "POST", headers: { authorization: "Bearer sk-test", "content-type": "application/json" } });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ model: "kolors", prompt: "a fox", ratio: "16:9", refs: 1 });
    // The result is fetched without the key.
    expect(requests[1]).toMatchObject({ url: "https://cdn.flow.example/one.png", method: "GET" });
    expect(requests[1]!.headers.authorization).toBeUndefined();
  });

  it("puts the key in the query when the manifest says so", async () => {
    const { media, requests } = await setup(IMAGE_START, { media: { auth: { query: "key" } } });
    const model = await firstModel(media);
    await media.generateImage(model, { prompt: "a fox" });
    expect(requests[0]!.url).toBe("https://api.flow.example/v1/images?key=sk-test");
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it("downloads a key-only GIF result with the key when the adapter asks", async () => {
    const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]);
    const { media, requests } = await setup(`export default { image: { start: () => ({ outputs: [{ url: "https://api.flow.example/v1/characters/c1/gif", auth: true }] }) } };`,
      { reply: (url) => url.endsWith("/gif") ? new Response(GIF, { headers: { "content-type": "image/gif" } }) : undefined });
    expect(await media.generateImage(await firstModel(media), { prompt: "a fox" })).toEqual({ bytes: GIF, mediaType: "image/gif" });
    expect(requests[0]).toMatchObject({ url: "https://api.flow.example/v1/characters/c1/gif", method: "GET", headers: { authorization: "Bearer sk-test" } });
    // The key goes only to an approved host.
    const elsewhere = await setup(`export default { image: { start: () => ({ outputs: [{ url: "https://other.example/x.gif", auth: true }] }) } };`);
    await expect(elsewhere.media.generateImage(await firstModel(elsewhere.media), { prompt: "x" })).rejects.toThrow("other.example isn't in the plugin's capabilities.network");
    expect(elsewhere.requests).toEqual([]);
  });

  it("needs a model's required references and scales them to its longest side", async () => {
    const adapter = `export default { image: { async start(input, host) {
      await host.fetch("https://api.flow.example/v1/rig", { method: "POST", auth: true, json: { references: input.references } });
      return { outputs: [{ url: "https://cdn.flow.example/one.png" }] };
    } } };`;
    const { media, requests } = await setup(adapter, { media: { image: { models: [{ id: "rig", title: "Rig", resolutions: ["1K"], aspectRatios: ["1:1"], minReferenceImages: 1, maxReferenceImages: 2, maxReferenceImageDimension: 16 }] } } as Partial<Media> });
    expect(await firstModel(media)).toMatchObject({ minReferenceImages: 1, maxReferenceImages: 2 });
    const images = new ProviderImages(async () => { throw new Error("no runtime"); }, fetch, () => undefined, () => true, { pluginImages: media });
    const rig = { provider: "plugin.acme.flow.flow", id: "rig" };
    await expect(images.generate({ prompt: "walk", imageModel: rig, resolution: "1K", aspectRatio: "1:1" })).rejects.toThrow("needs at least 1 reference image");
    expect(requests).toEqual([]);
    const large = await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff0000" } }).jpeg().toBuffer();
    const small = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#00ff00" } }).png().toBuffer();
    await images.generate({ prompt: "walk", imageModel: rig, resolution: "1K", aspectRatio: "1:1", images: [{ mediaType: "image/jpeg", data: large.toString("base64") }, { mediaType: "image/png", data: small.toString("base64") }] });
    const [scaled, kept] = (JSON.parse(requests[0]!.body!) as { references: Array<{ mediaType: string; base64: string }> }).references;
    expect(scaled!.mediaType).toBe("image/png");
    expect(await sharp(Buffer.from(scaled!.base64, "base64")).metadata()).toMatchObject({ format: "png", width: 16, height: 8 });
    expect(kept).toEqual({ mediaType: "image/png", base64: small.toString("base64") });
  });

  it.each(["complete", "deadline", "cancel"] as const)("keeps synchronous image requests within their three-minute budget: %s", async (ending) => {
    let started!: (signal: AbortSignal) => void;
    const requested = new Promise<AbortSignal>((resolve) => { started = resolve; });
    let finish!: () => void;
    const { media, requests } = await setup(IMAGE_START, { reply: (url, signal) => {
      if (!url.endsWith("/images")) return undefined;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal!.reason);
        finish = () => {
          signal!.removeEventListener("abort", abort);
          resolve(Response.json({ url: "https://cdn.flow.example/one.png" }));
        };
        signal!.addEventListener("abort", abort, { once: true });
        started(signal!);
      });
    } });
    const model = await firstModel(media);
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Node's AbortSignal.timeout uses native timers; route them through the same test clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const timed = new AbortController();
      setTimeout(() => timed.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return timed.signal;
    });
    const result = media.generateImage(model, { prompt: "fox" }, controller.signal)
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      const requestSignal = await requested;
      await vi.advanceTimersByTimeAsync(170_000);
      expect(requestSignal.aborted).toBe(false);
      if (ending === "complete") {
        finish();
        expect(await result).toEqual({ value: { bytes: PNG, mediaType: "image/png" } });
      } else {
        if (ending === "cancel") controller.abort(new Error("user stopped"));
        else await vi.advanceTimersByTimeAsync(11_000);
        expect(requestSignal.aborted).toBe(true);
        expect(await result).toEqual({ error: expect.any(Error) });
      }
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
      controller.abort(new Error("test cleanup"));
      finish?.();
      await result;
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("checks a task at the adapter's pace until it has the result", async () => {
    const { media, requests } = await setup(`export default { image: {
      async start(input, host) { return { task: { id: "t1", checks: 0 }, retryAfter: 0.01 }; },
      async check(task, host) {
        await host.fetch("https://api.flow.example/v1/tasks/" + task.id, { auth: true });
        return task.checks < 1 ? { task: { ...task, checks: task.checks + 1 }, retryAfter: 1 } : { outputs: [{ base64: "${PNG.toString("base64")}" }] };
      },
    } };`);
    const model = await firstModel(media);
    const started = Date.now();
    expect((await media.generateImage(model, { prompt: "a fox" })).bytes).toEqual(PNG);
    // retryAfter is kept to at least a second.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/tasks/t1", "https://api.flow.example/v1/tasks/t1"]);
  }, 10_000);

  it("shows the vendor's error, and refuses hosts and results the plugin wasn't allowed", async () => {
    const failing = await setup(`export default { image: { start: () => ({ error: "Not enough credit" }) } };`);
    const model = await firstModel(failing.media);
    await expect(failing.media.generateImage(model, { prompt: "x" })).rejects.toThrow("Flow: Not enough credit");
    const elsewhere = await setup(`export default { image: { async start(input, host) { await host.fetch("https://collect.evil.example/", { auth: true }); return { outputs: [] }; } } };`);
    await expect(elsewhere.media.generateImage(model, { prompt: "x" })).rejects.toThrow("collect.evil.example isn't in the plugin's capabilities.network");
    expect(elsewhere.requests).toEqual([]);
    const result = await setup(`export default { image: { start: () => ({ outputs: [{ url: "https://other.example/x.png" }] }) } };`);
    await expect(result.media.generateImage(model, { prompt: "x" })).rejects.toThrow("other.example isn't in the plugin's capabilities.network");
    const notPicture = await setup(`export default { image: { start: () => ({ outputs: [{ base64: "aGVsbG8=" }] }) } };`);
    await expect(notPicture.media.generateImage(model, { prompt: "x" })).rejects.toThrow("isn't a PNG, JPEG, WebP or GIF picture");
  });

  it("leaves out a plugin whose hosts the person hasn't allowed", async () => {
    expect(await (await setup(IMAGE_START, { allowed: false })).media.imageProviders()).toEqual([]);
  });

  it.each(["127.0.0.1", "localhost"])("uses an explicitly approved local HTTP port on %s for requests and outputs", async hostname => {
    const origin = `http://${hostname}:8188`;
    const { media, requests } = await setup(`export default { image: { async start(input, host) {
      await host.fetch(${JSON.stringify(origin + "/prompt")}, { method: "POST", auth: true, json: { prompt: input.prompt } });
      return { outputs: [{ url: ${JSON.stringify(origin + "/view")} }] };
    } } };`, { network: [`${hostname}:8188`], reply: () => new Response(PNG) });
    expect((await media.generateImage(await firstModel(media), { prompt: "fox" })).bytes).toEqual(PNG);
    expect(requests.map(request => [request.url, request.method, request.headers.authorization])).toEqual([
      [origin + "/prompt", "POST", "Bearer sk-test"], [origin + "/view", "GET", undefined],
    ]);
  });

  it.each([
    ["http://127.0.0.1:8188/view", ["127.0.0.1"]],
    ["http://localhost:8188/view", ["localhost"]],
    ["http://127.0.0.1:8189/view", ["127.0.0.1:8188"]],
    ["http://localhost:8188/view", ["127.0.0.1:8188"]],
    ["http://192.168.1.10:8188/view", ["192.168.1.10:8188"]],
    ["http://api.flow.example:8188/view", ["api.flow.example:8188"]],
    ["http://localhost.evil.example:8188/view", ["localhost.evil.example:8188"]],
    ["http://user:password@127.0.0.1:8188/view", ["127.0.0.1:8188"]],
  ])("rejects unapproved or non-loopback HTTP %s before requests and downloads", async (url, network) => {
    for (const output of [false, true]) {
      const operation = output ? `return { outputs: [{ url: ${JSON.stringify(url)} }] };`
        : `await host.fetch(${JSON.stringify(url)}, { auth: true }); return { outputs: [] };`;
      const { media, requests } = await setup(`export default { image: { async start(input, host) { ${operation} } } };`, { network });
      await expect(media.generateImage(await firstModel(media), { prompt: "fox" })).rejects.toThrow();
      expect(requests).toHaveLength(0);
    }
  });

  it("downloads from a real approved loopback server without following request or output redirects", async () => {
    const server = Fastify();
    let origin = "", redirect: "request" | "output" | undefined;
    const received: Array<[string, string | undefined]> = [];
    server.addHook("onRequest", async request => { received.push([request.url, request.headers.authorization]); });
    server.post("/prompt", async (_request, reply) => redirect === "request"
      ? reply.redirect(origin + "/unexpected") : { url: origin + (redirect === "output" ? "/redirect" : "/view") });
    server.get("/view", async (_request, reply) => reply.type("image/png").send(PNG));
    server.get("/redirect", async (_request, reply) => reply.redirect(origin + "/unexpected"));
    server.get("/unexpected", async () => { throw new Error("A redirect must not be followed"); });
    origin = await server.listen({ port: 0, host: "127.0.0.1" });
    const { entry } = await setup(`export default { image: { async start(input, host) {
      const response = await host.fetch(${JSON.stringify(origin + "/prompt")}, { method: "POST", auth: true, json: { prompt: input.prompt } });
      if (!response.ok) return { error: "Request answered " + response.status };
      return { outputs: [{ url: (await response.json()).url }] };
    } } };`, { network: [new URL(origin).host] });
    const media = new PluginMediaProviders({ everyProject: async () => [entry], values: { secret: () => "sk-test" } } as unknown as PluginServices);
    try {
      const model = await firstModel(media);
      expect((await media.generateImage(model, { prompt: "fox" })).bytes).toEqual(PNG);
      expect(received).toEqual([["/prompt", "Bearer sk-test"], ["/view", undefined]]);
      for (redirect of ["request", "output"] as const)
        await expect(media.generateImage(model, { prompt: "fox" })).rejects.toThrow("302");
      expect(received.map(([url]) => url)).toEqual(["/prompt", "/view", "/prompt", "/prompt", "/redirect"]);
      expect(received.at(-1)?.[1]).toBeUndefined();
    } finally { await media.close(); await server.close(); }
  });

  it("never shows the adapter the key, even where the vendor echoes it", async () => {
    const { media } = await setup(`export default { image: { async start(input, host) {
      const response = await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true });
      return { error: response.headers.location + " " + (await response.text()) };
    } } };`, {
      key: "sk/te st",
      media: { auth: { query: "key" } },
      reply: (url) => url.startsWith("https://api.flow.example/") ? new Response(`echo ${new URL(url).searchParams.get("key")} ${JSON.stringify(new URL(url).searchParams.get("key")).replaceAll("/", "\\/")}`, { status: 302, headers: { location: url } }) : undefined,
    });
    const error = await media.generateImage(await firstModel(media), { prompt: "x" }).catch((cause: Error) => cause.message);
    expect(error).toBe('Flow: https://api.flow.example/v1/images?key=[key] echo [key] "[key]"');

    // JSON may spell it with escapes, which json() would undo.
    const escaped = await setup(`export default { image: { async start(input, host) {
      const response = await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true });
      return { error: (await response.json()).token };
    } } };`, { reply: (url) => url.startsWith("https://api.flow.example/") ? new Response('{"token":"\\u0073k-test"}') : undefined });
    expect(await escaped.media.generateImage(await firstModel(escaped.media), { prompt: "x" }).catch((cause: Error) => cause.message)).toBe("Flow: [key]");
    const encoded = await setup(`export default { image: { async start(input, host) {
      const response = await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true });
      return { error: (await response.json()).token };
    } } };`, { key: "sk/te st", reply: (url) => url.startsWith("https://api.flow.example/") ? new Response('{"token":"\\u0073k%2Fte%20st"}') : undefined });
    expect(await encoded.media.generateImage(await firstModel(encoded.media), { prompt: "x" }).catch((cause: Error) => cause.message)).toBe("Flow: [key]");
    const numeric = await setup(`export default { image: { async start(input, host) {
      const response = await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true });
      return { error: await response.text() };
    } } };`, { key: "12345", reply: (url) => url.startsWith("https://api.flow.example/") ? new Response('{"id":12345,"token":"\\u0031\\u0032\\u0033\\u0034\\u0035"}') : undefined });
    expect(await numeric.media.generateImage(await firstModel(numeric.media), { prompt: "x" }).catch((cause: Error) => cause.message)).toBe('Flow: {"id":[key],"token":"[key]"}');
    // Nor through text(), whatever json() would keep of the body.
    const twice = await setup(`export default { image: { async start(input, host) {
      const response = await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true });
      return { error: await response.text() };
    } } };`, { reply: (url) => url.startsWith("https://api.flow.example/") ? new Response('{"token":"\\u0073k-test","token":"safe"}') : undefined });
    expect(await twice.media.generateImage(await firstModel(twice.media), { prompt: "x" }).catch((cause: Error) => cause.message)).not.toContain("sk-test");
  });

  it("tells the vendor to stop a task when checking it fails", async () => {
    const { media, requests } = await setup(`export default { image: {
      start: () => ({ task: { id: "t1" }, retryAfter: 1 }),
      check() { throw new Error("adapter broke"); },
      async cancel(task, host) { await host.fetch("https://api.flow.example/v1/tasks/" + task.id + "/cancel", { method: "POST", auth: true }); return null; },
    } };`);
    await expect(media.generateImage(await firstModel(media), { prompt: "x" })).rejects.toThrow("adapter broke");
    await expect.poll(() => requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/tasks/t1/cancel"]);
  });

  it("tells the vendor to stop a task when the person stops waiting", async () => {
    const { media, requests } = await setup(`export default { image: {
      start: () => ({ task: { id: "t1" }, retryAfter: 5 }),
      check: () => ({ error: "never checked" }),
      async cancel(task, host) { await host.fetch("https://api.flow.example/v1/tasks/" + task.id + "/cancel", { method: "POST", auth: true }); return null; },
    } };`);
    const controller = new AbortController();
    const pending = media.generateImage(await firstModel(media), { prompt: "x" }, controller.signal);
    setTimeout(() => controller.abort(new Error("stopped by the person")), 100);
    await expect(pending).rejects.toThrow("stopped by the person");
    await expect.poll(() => requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/tasks/t1/cancel"]);
  });

  it("joins the image catalog and takes requests for its models", async () => {
    const { media, requests } = await setup(IMAGE_START);
    const images = new ProviderImages(async () => { throw new Error("no runtime"); }, fetch, () => undefined, () => true, { pluginImages: media });
    const catalog = await images.catalog();
    expect(catalog.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["plugin.acme.flow.flow/kolors"]);
    expect(catalog.providers).toEqual([{ provider: "plugin.acme.flow.flow", providerName: "Flow", state: "ready" }]);
    // A legacy size becomes the model's nearest resolution and aspect ratio.
    const image = await images.generate({ prompt: "a fox", imageModel: { provider: "plugin.acme.flow.flow", id: "kolors" }, size: "1024x1024" });
    expect(image.mediaType).toBe("image/png");
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ ratio: "1:1" });
    await expect(images.generate({ prompt: "a fox", imageModel: { provider: "plugin.acme.flow.flow", id: "kolors" }, resolution: "4K", aspectRatio: "1:1" }))
      .rejects.toThrow("not supported by the selected model");
    // Off in Settings, it leaves the catalog.
    const off = new ProviderImages(async () => { throw new Error("no runtime"); }, fetch, () => undefined, () => false, { pluginImages: media });
    expect((await off.catalog()).models).toEqual([]);
  });
});

const VIDEO_MEDIA = { video: { models: [{ id: "wan", title: "Wan", durations: [5], resolutions: ["720p"], aspectRatios: ["16:9"], maxReferenceImages: 2 }] } } as unknown as Partial<Media>;

// Starts a task, checks it once, then has the result.
const VIDEO_TASK = `export default { video: {
  async start(input, host) {
    const answer = await (await host.fetch("https://api.flow.example/v1/videos", { method: "POST", auth: true, json: { model: input.model, seconds: input.duration, frames: input.references.length, mode: input.referenceMode } })).json();
    return { task: { id: answer.id, checks: 0 }, retryAfter: 0 };
  },
  async check(task, host) {
    await host.fetch("https://api.flow.example/v1/videos/" + task.id, { auth: true });
    return task.checks < 1 ? { task: { ...task, checks: task.checks + 1 }, retryAfter: 0 } : { outputs: [{ url: "https://cdn.flow.example/" + task.id + ".mp4" }] };
  },
  async cancel(task, host) { await host.fetch("https://api.flow.example/v1/videos/" + task.id + "/cancel", { method: "POST", auth: true }); return null; },
} };`;

const firstVideo = async (media: PluginMediaProviders): Promise<VideoModel> => (await media.videoProviders())[0]!.models[0]!;
const journalAt = (id = "job-1") => mediaTaskJournal(path.join(root, "media-tasks"), id);

describe("opted-in image recovery", () => {
  const recoverable = { image: { recoverable: true, models: [{ id: "kolors", resolutions: ["1K"], aspectRatios: ["1:1"] }] } } as unknown as Partial<Media>;

  const imagesFor = (media: PluginMediaProviders) => new ProviderImages(async () => { throw new Error("no runtime"); }, fetch, () => undefined, () => true, { pluginImages: media });

  it("refuses unsupported retry state without rewriting canvas or tool-job history", async () => {
    const record = JSON.stringify([{ id: "future", toolId: "generate-image", status: "failed", resuming: 2,
      context: { projectId: "p", boardId: "b", nodeId: "n" }, futureData: { keep: true } }]);
    const workspace = path.join(root, "project");
    await mkdir(path.join(workspace, "canvas"), { recursive: true });
    const canvasHistory = path.join(workspace, "canvas/jobs.json");
    await writeFile(canvasHistory, record);
    await expect(readCanvasJobHistory(workspace, "p")).rejects.toThrow("Invalid generation history");
    expect(await readFile(canvasHistory, "utf8")).toBe(record);
    await mkdir(path.join(root, "tools"));
    const toolHistory = path.join(root, "tools/jobs.json");
    await writeFile(toolHistory, record);
    const tools = new ToolRunner(root, { generate: vi.fn() });
    await expect(tools.load()).rejects.toThrow("Unsupported generation retry state");
    await tools.close();
    expect(await readFile(toolHistory, "utf8")).toBe(record);
  });

  const workflowConfiguration = {
    workflow: { type: "json" as const, title: "Workflow", required: true },
    promptNode: { type: "text" as const, title: "Prompt node", default: "6" },
  };
  const workflowMedia: Partial<Media> = { image: { recoverable: true, configuration: ["workflow", "promptNode"], models: [{
    id: "workflow", resolutions: [], aspectRatios: [], supportsResolution: false, supportsAspectRatio: false,
  }] } };
  const WORKFLOW_START = `export default { image: {
    async start(input, host) {
      const response = await host.submit("image", "https://api.flow.example/prompt", { method: "POST", json: input });
      return { task: { id: (await response.json()).id }, retryAfter: 1 };
    },
    async check(task, host) {
      const response = await host.fetch("https://api.flow.example/history/" + task.id);
      return { outputs: [{ url: (await response.json()).url }] };
    }
  } };`;

  it("pins workflow settings before submission and replays them after settings are cleared and the host restarts", async () => {
    const file = path.join(root, "settings.json"), values = new PluginValues(file);
    await values.load();
    const first = await setup(WORKFLOW_START, { media: workflowMedia, configuration: workflowConfiguration, values });
    const workflow = { "6": { class_type: "CLIPTextEncode", inputs: { text: "original", unknown: "keep" } }, "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } } };
    await values.update(first.entry, { apiKey: "secret-key", workflow: JSON.stringify(workflow) });
    const model = await firstModel(first.media), journal = await journalAt();
    expect(model).toMatchObject({ supportsResolution: false, supportsAspectRatio: false, generationOptions: [] });
    vi.spyOn(journal, "save").mockRejectedValueOnce(new Error("Receipt disk unavailable"));
    await expect(imagesFor(first.media).generate({ prompt: "fox", imageModel: { provider: model.provider, id: model.id }, resolution: "4K", aspectRatio: "21:9" }, undefined, { journal })).rejects.toThrow("Receipt disk unavailable");
    const sent = JSON.parse(first.requests[0]!.body!);
    expect(sent.configuration).toEqual({ workflow, promptNode: "6" });
    expect(sent).not.toHaveProperty("resolution"); expect(sent).not.toHaveProperty("aspectRatio");
    expect(JSON.stringify(sent)).not.toContain("secret-key");
    await values.update(first.entry, { workflow: null, promptNode: "other" });
    const restored = new PluginValues(file); await restored.load();
    const next = await setup(WORKFLOW_START, { media: workflowMedia, configuration: workflowConfiguration, values: restored });
    expect((await next.media.generateImage(model, { prompt: "fox", resolution: "4K", aspectRatio: "21:9" }, undefined, { journal: await journalAt(), resuming: true })).bytes).toEqual(PNG);
    expect(first.requests.map(request => request.method)).toEqual(["POST"]);
    expect(next.requests.map(request => request.method)).toEqual(["GET", "GET"]);
    // A new job uses current settings and fails before any request if the required workflow is absent.
    await expect(next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt("new-job") })).rejects.toThrow("Configure workflow");
    expect(await inspectMediaTaskJournal(path.join(root, "media-tasks"), "new-job")).toBe("missing");
  });

  it.each(["binding", "package", "lost-response"])("refuses workflow replay after %s changes without submitting again", async changed => {
    const values = new PluginValues(path.join(root, "settings.json")); await values.load();
    const first = await setup(WORKFLOW_START, { media: workflowMedia, configuration: workflowConfiguration, values,
      ...(changed === "lost-response" ? { reply: () => { throw new Error("Lost response"); } } : {}),
    });
    await values.update(first.entry, { apiKey: "key", workflow: "{}" });
    const model = await firstModel(first.media), journal = await journalAt();
    vi.spyOn(journal, "save").mockRejectedValueOnce(new Error("Receipt disk unavailable"));
    await expect(first.media.generateImage(model, { prompt: "fox" }, undefined, { journal })).rejects.toThrow();
    const saved = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    const next = await setup(WORKFLOW_START, { media: changed === "binding" ? { image: { ...workflowMedia.image!, configuration: ["workflow"] } } : workflowMedia,
      configuration: workflowConfiguration, values, ...(changed === "package" ? { digest: "d2" } : {}),
    });
    await expect(next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).rejects.toThrow(/changed|uncertain|confirm|lost/);
    expect(first.requests).toHaveLength(1); expect(next.requests).toHaveLength(0);
    expect(await readFile(path.join(root, "media-tasks/job-1.json"), "utf8")).toBe(saved);
  });

  it("bounds the combined workflow settings and refuses secrets before running the adapter", async () => {
    const values = new PluginValues(path.join(root, "settings.json")); await values.load();
    const configuration = { ...workflowConfiguration, extra: { type: "json" as const, title: "Extra" } };
    const first = await setup(WORKFLOW_START, { media: { image: { ...workflowMedia.image!, configuration: ["workflow", "extra"] } }, configuration, values });
    await values.update(first.entry, { apiKey: "key", workflow: JSON.stringify({ text: "a".repeat(140_000) }), extra: JSON.stringify({ text: "b".repeat(140_000) }) });
    const model = await firstModel(first.media);
    await expect(first.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt() })).rejects.toThrow("Combined image settings");
    const unsafe = await setup(WORKFLOW_START, { media: { image: { ...workflowMedia.image!, configuration: ["apiKey"] } }, configuration, values });
    await expect(unsafe.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt() })).rejects.toThrow("Invalid image setting");
    expect(first.requests).toHaveLength(0); expect(unsafe.requests).toHaveLength(0);
  });

  it("recreates the canvas and tool runner after import failure without another image submission", async () => {
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const { media, requests } = await setup(IMAGE_START, { media: recoverable, reply: url => url.startsWith("https://cdn.") ? new Response(new Uint8Array(image)) : undefined });
    const library = new AssetLibrary(root), projects = new ProjectManager(root, library);
    let tools = new ToolRunner(root, imagesFor(media), undefined, undefined, library);
    await Promise.all([library.load(), projects.load(), tools.load()]);
    const project = await projects.create("Recover image", "asset-canvas");
    let store = new CanvasStore(projects, library, tools);
    try {
      const boardId = (await store.workspace(project.id)).boards[0]!.id;
      const detail = await store.board(project.id, boardId);
      const node = createAssetGenerationNode("image", { x: 0, y: 0 });
      if (node.type !== "image") throw new Error("Expected image");
      const { provider, id } = await firstModel(media);
      Object.assign(node.data, { prompt: "fox", model: { provider, id }, resolution: "1K", aspectRatio: "1:1" });
      detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
      await store.saveBoard(project.id, detail.board, detail.revision);
      const materialize = vi.spyOn(projects, "materializeLibraryAsset").mockRejectedValueOnce(new Error("Import disk unavailable"));
      const first = await store.generateNode(project.id, boardId, node.id);
      await expect.poll(async () => (await store.jobs(project.id))[0]?.status).toBe("failed");
      expect((await store.jobs(project.id))[0]?.error).toContain("Import disk unavailable");
      materialize.mockRestore();
      await store.close(); await tools.close();
      tools = new ToolRunner(root, imagesFor(media), undefined, undefined, library);
      await tools.load(); store = new CanvasStore(projects, library, tools);
      await store.retry(project.id, first.id);
      await expect.poll(async () => (await store.jobs(project.id))[0]?.status).toBe("succeeded");
      expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
      expect((await store.jobs(project.id))[0]).not.toHaveProperty("resuming");
      const history = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"));
      expect(history[0].resuming).toBe(true);
      expect(history[0].recoveryId).toBe(history[1].recoveryId);
      expect(await inspectMediaTaskJournal(path.join(root, "tools/media-tasks"), history[0].recoveryId)).toBe("result-recorded");
    } finally { await store.close(); await tools.close(); await media.close(); }
  });

  it("saves a GIF result on the canvas and passes its first frame on as a scaled PNG reference", async () => {
    const frames = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).gif().toBuffer();
    const adapter = `export default { image: { async start(input, host) {
      await host.submit("image", "https://api.flow.example/v1/rig", { method: "POST", auth: true, json: { references: input.references } });
      return { outputs: [{ url: "https://api.flow.example/v1/result.gif", auth: true }] };
    } } };`;
    const models = [{ id: "rig", resolutions: ["1K"], aspectRatios: ["1:1"], maxReferenceImages: 1, maxReferenceImageDimension: 64 }];
    const { media, requests } = await setup(adapter, { media: { image: { recoverable: true, models } } as unknown as Partial<Media>,
      reply: url => url.endsWith(".gif") ? new Response(new Uint8Array(frames)) : undefined });
    const library = new AssetLibrary(root), projects = new ProjectManager(root, library);
    const tools = new ToolRunner(root, imagesFor(media), undefined, undefined, library);
    await Promise.all([library.load(), projects.load(), tools.load()]);
    const project = await projects.create("GIF result", "asset-canvas");
    const store = new CanvasStore(projects, library, tools);
    try {
      const boardId = (await store.workspace(project.id)).boards[0]!.id;
      const detail = await store.board(project.id, boardId);
      const [first, second] = [createAssetGenerationNode("image", { x: 0, y: 0 }), createAssetGenerationNode("image", { x: 400, y: 0 })];
      if (first.type !== "image" || second.type !== "image") throw new Error("Expected image");
      const model = { provider: "plugin.acme.flow.flow", id: "rig" };
      Object.assign(first.data, { prompt: "walk", model, resolution: "1K", aspectRatio: "1:1" });
      Object.assign(second.data, { prompt: "run", model, resolution: "1K", aspectRatio: "1:1", images: [{ type: "node", nodeId: first.id }] });
      for (const node of [first, second]) { detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position; }
      await store.saveBoard(project.id, detail.board, detail.revision);
      await store.generateNode(project.id, boardId, first.id);
      await expect.poll(async () => (await store.jobs(project.id))[0]?.status).toBe("succeeded");
      const assets = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/assets.json"), "utf8")).assets as Record<string, { path: string }>;
      expect(Object.values(assets).map(asset => path.extname(asset.path))).toEqual([".gif"]);
      expect(requests.find(request => request.url.endsWith(".gif"))?.headers.authorization).toBe("Bearer sk-test");
      await store.generateNode(project.id, boardId, second.id);
      await expect.poll(async () => (await store.jobs(project.id)).filter(job => job.status === "succeeded")).toHaveLength(2);
      const sent = (JSON.parse(requests.filter(request => request.method === "POST")[1]!.body!) as { references: Array<{ mediaType: string; base64: string }> }).references[0]!;
      expect(sent.mediaType).toBe("image/png");
      expect(await sharp(Buffer.from(sent.base64, "base64")).metadata()).toMatchObject({ format: "png", width: 64, height: 64 });
    } finally { await store.close(); await tools.close(); await media.close(); }
  });

  it.each([[true, true], [false, true], [true, false], [false, false]])("recreates tool-job history across recovery capability changes: %s → %s", async (optedIn, nextOptedIn) => {
    const first = await setup(IMAGE_START, { ...(optedIn ? { media: recoverable } : {}), reply: url => { if (url.startsWith("https://cdn.")) throw new Error("offline"); return undefined; } });
    let tools = new ToolRunner(root, imagesFor(first.media));
    await tools.load();
    const { provider, id } = await firstModel(first.media);
    const job = tools.start("generate-image", { prompt: "fox", imageModel: { provider, id }, resolution: "1K", aspectRatio: "1:1" });
    await expect.poll(() => tools.jobs().find(item => item.id === job.id)?.status).toBe("failed");
    await tools.close(); await first.media.close();
    const next = await setup(IMAGE_START, { ...(nextOptedIn ? { media: recoverable } : {}) });
    tools = new ToolRunner(root, imagesFor(next.media));
    try {
      await tools.load();
      const retry = tools.retryJob(job.id);
      await expect.poll(() => tools.jobs().find(item => item.id === retry.id)?.status).toBe(optedIn === nextOptedIn ? "succeeded" : "failed");
      if (!optedIn && nextOptedIn) expect(tools.jobs().find(item => item.id === retry.id)?.error).toContain("no saved image task");
      if (optedIn && !nextOptedIn) expect(tools.jobs().find(item => item.id === retry.id)?.error).toContain("no longer supports image recovery");
      expect(first.requests.filter(request => request.method === "POST")).toHaveLength(1);
      expect(next.requests.map(request => request.method)).toEqual(optedIn === nextOptedIn ? (optedIn ? ["GET"] : ["POST", "GET"]) : []);
      expect(tools.jobs().find(item => item.id === retry.id)).not.toHaveProperty("resuming");
    } finally { await tools.close(); await next.media.close(); }
  });

  it("retains a paid result after download failure and rejects changed input on retry", async () => {
    const first = await setup(IMAGE_START, { media: recoverable, reply: url => { if (url.startsWith("https://cdn.")) throw new Error("offline"); return undefined; } });
    const model = await firstModel(first.media);
    await expect(first.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt() })).rejects.toThrow("downloaded");
    const next = await setup(IMAGE_START, { media: recoverable });
    await expect(next.media.generateImage(model, { prompt: "changed" }, undefined, { journal: await journalAt(), resuming: true })).rejects.toThrow("request changed");
    expect(next.requests).toHaveLength(0);
    expect((await next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).bytes).toEqual(PNG);
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(next.requests.map(request => request.method)).toEqual(["GET"]);
  });

  it("does not turn a formerly non-recoverable image into a new paid task after a plugin upgrade", async () => {
    const previous = await setup(IMAGE_START);
    const model = await firstModel(previous.media);
    await previous.media.generateImage(model, { prompt: "fox" });
    const next = await setup(IMAGE_START, { media: recoverable });
    await expect(next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).rejects.toThrow("no saved image task");
    expect(next.requests).toHaveLength(0);
    expect(await inspectMediaTaskJournal(path.join(root, "media-tasks"), "job-1")).toBe("missing");
  });

  it("does not discard a durable image receipt when the plugin loses recovery support", async () => {
    const first = await setup(IMAGE_START, { media: recoverable, reply: url => { if (url.startsWith("https://cdn.")) throw new Error("offline"); return undefined; } });
    const model = await firstModel(first.media);
    await expect(first.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt() })).rejects.toThrow("downloaded");
    const before = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    const older = await setup(IMAGE_START);
    await expect(older.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).rejects.toThrow("no longer supports image recovery");
    expect(older.requests).toHaveLength(0);
    expect(await readFile(path.join(root, "media-tasks/job-1.json"), "utf8")).toBe(before);
  });

  it("requires one output and a durable owner before an opted-in image can be submitted", async () => {
    const { media, requests } = await setup(IMAGE_START, { media: recoverable });
    const model = await firstModel(media);
    await expect(media.generateImage(model, { prompt: "fox" })).rejects.toThrow("durable image job");
    await expect(media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), outputs: 2 })).rejects.toThrow("one output");
    expect(requests).toHaveLength(0);
  });

  it("refuses to replay an image submission whose response was lost", async () => {
    const first = await setup(IMAGE_START, { media: recoverable, reply: () => { throw new Error("answer lost"); } });
    const model = await firstModel(first.media);
    await expect(first.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt() })).rejects.toThrow("could not be reached");
    const next = await setup(IMAGE_START, { media: recoverable });
    await expect(next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).rejects.toThrow("answer was lost");
    expect(first.requests).toHaveLength(1);
    expect(next.requests).toHaveLength(0);
  });

  it("replays a saved submit response when recording the image task failed", async () => {
    const adapter = `export default { image: {
      async start(input, host) {
        const reply = await host.submit("image", "https://api.flow.example/prompt", { method: "POST", auth: true, json: { prompt: input.prompt } });
        return { task: { id: (await reply.json()).id }, retryAfter: 1 };
      },
      async check(task, host) {
        const reply = await host.fetch("https://api.flow.example/history/" + task.id);
        return { outputs: [{ url: (await reply.json()).url }] };
      }
    } };`;
    const first = await setup(adapter, { media: recoverable });
    const model = await firstModel(first.media), journal = await journalAt();
    vi.spyOn(journal, "save").mockRejectedValueOnce(new Error("Task receipt disk unavailable"));
    await expect(first.media.generateImage(model, { prompt: "fox" }, undefined, { journal })).rejects.toThrow("Task receipt disk unavailable");
    const next = await setup(adapter, { media: recoverable });
    expect((await next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).bytes).toEqual(PNG);
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(next.requests.map(request => request.method)).toEqual(["GET", "GET"]);
    expect(await inspectMediaTaskJournal(path.join(root, "media-tasks"), "job-1")).toBe("task-recorded");
  });

  it.each(["stop", "shutdown"])("keeps a queued image after %s and resumes only its recorded task", async ending => {
    const adapter = `export default { image: {
      async start(input, host) {
        const reply = await host.submit("image", "http://127.0.0.1:8188/prompt", { method: "POST", json: { prompt: input.prompt } });
        return { task: { id: (await reply.json()).id }, retryAfter: 1 };
      },
      async check(task, host) {
        const reply = await host.fetch("http://127.0.0.1:8188/history/" + encodeURIComponent(task.id));
        return { outputs: [{ url: (await reply.json()).url }] };
      },
      cancel(task, host) { return host.fetch("http://127.0.0.1:8188/interrupt", { method: "POST" }); }
    } };`;
    const options = { media: recoverable, network: ["127.0.0.1:8188"], reply: (url: string) => url.endsWith("/view") ? new Response(PNG) : Response.json({ id: "prompt-1", url: "http://127.0.0.1:8188/view" }) };
    const first = await setup(adapter, { ...options, reply: async (url, signal) => {
      if (!url.includes("/history/")) return options.reply(url);
      signal!.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    } });
    const model = await firstModel(first.media), controller = new AbortController();
    const pending = first.media.generateImage(model, { prompt: "fox" }, controller.signal, { journal: await journalAt() });
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(() => inspectMediaTaskJournal(path.join(root, "media-tasks"), "job-1")).toBe("task-recorded");
    controller.abort(ending === "shutdown" ? new GenerationShutdown() : new Error("stop waiting"));
    await rejected; await first.media.close();
    const next = await setup(adapter, options);
    try {
      expect((await next.media.generateImage(model, { prompt: "fox" }, undefined, { journal: await journalAt(), resuming: true })).bytes).toEqual(PNG);
      expect(first.requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["http://127.0.0.1:8188/prompt"]);
      expect(first.requests.every(request => ["POST", "GET"].includes(request.method))).toBe(true);
      expect(next.requests.map(request => request.url)).toEqual(["http://127.0.0.1:8188/history/prompt-1", "http://127.0.0.1:8188/view"]);
      expect(next.requests.every(request => request.method === "GET")).toBe(true);
    } finally { await next.media.close(); }
  });
});

describe("plugin media providers: video", () => {
  it("uses the same ratios as the picker for text, frames and reference images", async () => {
    const adapter = `export default { video: { async start(input, host) {
      await host.fetch("https://api.flow.example/v1/videos", { method: "POST", auth: true, json: { ratio: input.aspectRatio, mode: input.referenceMode, count: input.references.length } });
      return { outputs: [{ url: "https://cdn.flow.example/result.mp4" }] };
    } } };`;
    const { media, requests } = await setup(adapter, { media: { video: { models: [{
      id: "ratios", durations: [5], resolutions: ["720p"], aspectRatios: ["16:9", "9:16"],
      maxReferenceImages: 30, referenceModes: ["frame", "reference"],
      imageAspectRatios: ["adaptive", "16:9"], frameAspectRatios: ["adaptive"],
    }] } } as unknown as Partial<Media> });
    const model = await firstVideo(media);
    expect(model).toMatchObject({ imageAspectRatios: ["adaptive", "16:9"], frameAspectRatios: ["adaptive"] });
    const file = path.join(root, "first.png");
    await writeFile(file, PNG);
    const references = [{ type: "image" as const, name: "first.png", mediaType: "image/png", absolutePath: file }];
    await media.generateVideo(model, { prompt: "text" });
    await media.generateVideo(model, { prompt: "frame", references });
    await media.generateVideo(model, { prompt: "reference", references: Array(30).fill(references[0]), referenceMode: "reference", aspectRatio: "16:9" });
    expect(requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body!)))
      .toEqual([{ ratio: "16:9", count: 0 }, { ratio: "adaptive", mode: "frame", count: 1 }, { ratio: "16:9", mode: "reference", count: 30 }]);
    const count = requests.length;
    await expect(media.generateVideo(model, { prompt: "reference", references: Array(31).fill(references[0]), referenceMode: "reference" })).rejects.toThrow("up to 30 reference images");
    await expect(media.generateVideo(model, { prompt: "frame", references: Array(3).fill(references[0]), referenceMode: "frame" })).rejects.toThrow("up to 2 reference images");
    await expect(media.generateVideo(model, { prompt: "text", aspectRatio: "adaptive" })).rejects.toThrow("aspect ratio is not supported");
    await expect(media.generateVideo(model, { prompt: "frame", references, aspectRatio: "16:9" })).rejects.toThrow("aspect ratio is not supported");
    await expect(media.generateVideo(model, { prompt: "reference", references, referenceMode: "reference", aspectRatio: "9:16" })).rejects.toThrow("aspect ratio is not supported");
    expect(requests).toHaveLength(count);
  });

  it("preserves discovered reference ratios across model selection and restart", async () => {
    const model = { id: "discovered", durations: [5], resolutions: ["720p"], aspectRatios: ["16:9"], maxReferenceImages: 30,
      referenceModes: ["frame", "reference"], imageAspectRatios: ["adaptive", "16:9"], frameAspectRatios: ["adaptive"] };
    const adapter = `export default { video: { models: () => ({ models: ${JSON.stringify([model, { ...model, id: "invalid", frameAspectRatios: [] }, { ...model, id: "too-many", maxReferenceImages: 31 }])} }) } };`;
    const mediaSection: Partial<Media> = { video: { discoverModels: true, models: [] } };
    const { media } = await setup(adapter, { media: mediaSection, choices: new PluginMediaModelChoices(root) });
    const provider = "plugin.acme.flow.flow";
    expect(await media.listModels(provider, "video", true)).toMatchObject({ skipped: 2, models: [{ id: "discovered", shown: false }] });
    await media.setModelsShown(provider, "video", ["discovered"], true);
    const again = await setup(adapter, { media: mediaSection, choices: new PluginMediaModelChoices(root) });
    expect(await firstVideo(again.media)).toMatchObject({ maxImageReferences: 30, imageAspectRatios: model.imageAspectRatios, frameAspectRatios: model.frameAspectRatios });
  });

  it("lists a provider's video models and makes one through a task", async () => {
    const { media, requests } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA });
    const model = await firstVideo(media);
    expect(model).toEqual({ provider: "plugin.acme.flow.flow", providerName: "Flow", id: "wan", name: "Wan", durations: [5], resolutions: ["720p"], aspectRatios: ["16:9"],
      maxImageReferences: 2, imageReferenceMode: "frame", referenceModes: ["frame"] });
    await writeFile(path.join(root, "first.png"), PNG);
    const video = await media.generateVideo(model, { prompt: "a fox runs", duration: 5, references: [{ type: "image", name: "first.png", mediaType: "image/png", absolutePath: path.join(root, "first.png") }] }, undefined, await journalAt());
    expect(video).toEqual({ bytes: MP4, mediaType: "video/mp4" });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ model: "wan", seconds: 5, frames: 1, mode: "frame" });
    expect(requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/videos", "https://api.flow.example/v1/videos/t1", "https://api.flow.example/v1/videos/t1", "https://cdn.flow.example/t1.mp4"]);
    // The task stays until the caller stores the video: a retry checks it again, for a fresh address, without paying.
    const again = await media.generateVideo(model, { prompt: "a fox runs", duration: 5, references: [{ type: "image", name: "first.png", mediaType: "image/png", absolutePath: path.join(root, "first.png") }] }, undefined, await journalAt());
    expect(again.bytes).toEqual(MP4);
    expect(requests.map((request) => request.url).slice(4).filter((url) => url === "https://api.flow.example/v1/videos")).toEqual([]);
    await (await journalAt()).clear();
    expect((await journalAt().then((journal) => journal.begin({}))).state).toBe("new");
    await expect(media.generateVideo(model, { prompt: "x", duration: 10 })).rejects.toThrow("duration is not supported");
  }, 15_000);

  it("keeps the task when the app shuts down, and a retry checks it instead of starting again", async () => {
    const { media, requests } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA });
    const model = await firstVideo(media);
    const controller = new AbortController();
    const first = media.generateVideo(model, { prompt: "a fox" }, controller.signal, await journalAt());
    await expect.poll(() => requests.length).toBe(1);
    controller.abort(new GenerationShutdown());
    await expect(first).rejects.toBeInstanceOf(GenerationShutdown);
    // The vendor isn't told to stop: the task is resumed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/videos"]);
    const storedTask = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(await inspectMediaTaskJournal(path.join(root, "media-tasks"), "job-1")).toBe("task-recorded");
    expect(await readFile(path.join(root, "media-tasks/job-1.json"), "utf8")).toBe(storedTask);
    const video = await media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt());
    expect(video.bytes).toEqual(MP4);
    expect(requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/videos", "https://api.flow.example/v1/videos/t1", "https://api.flow.example/v1/videos/t1", "https://cdn.flow.example/t1.mp4"]);
    // A different request under the same id isn't mixed up with it.
    const changed = await setup(VIDEO_TASK, { media: VIDEO_MEDIA });
    const journal = await journalAt("job-2");
    await journal.begin({ plugin: "acme/flow", provider: "flow", kind: "video", input: { other: true } });
    await journal.save({ id: "t9" });
    journal.release();
    await expect(changed.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-2"))).rejects.toThrow("changed since this video started");
  }, 15_000);

  it("never starts again when a start's answer was lost", async () => {
    let fail = true;
    const { media, requests } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, reply: (url) => {
      if (fail && url === "https://api.flow.example/v1/videos") throw new TypeError("socket hang up");
      return undefined;
    } });
    const model = await firstVideo(media);
    await expect(media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt())).rejects.toThrow("api.flow.example could not be reached");
    fail = false;
    expect(await inspectMediaTaskJournal(path.join(root, "media-tasks"), "job-1")).toBe("unconfirmed");
    await expect(media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt())).rejects.toThrow("its answer was lost");
    expect(requests).toHaveLength(1);
    // A start the adapter refused before sending anything can be tried again.
    const refused = await setup(`export default { video: { start: () => { throw new Error("bad input"); } } };`, { media: VIDEO_MEDIA });
    await expect(refused.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-3"))).rejects.toThrow("bad input");
    await expect(refused.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-3"))).rejects.toThrow("bad input");
  });

  it("keeps a task whose start may have gone through, or whose result couldn't be fetched", async () => {
    // The vendor took the start, but the adapter couldn't read its answer: a retry doesn't pay again.
    const misread = await setup(`export default { video: { async start(input, host) {
      await host.fetch("https://api.flow.example/v1/videos", { method: "POST", auth: true });
      throw new Error("unexpected answer");
    } } };`, { media: VIDEO_MEDIA });
    const model = await firstVideo(misread.media);
    await expect(misread.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-4"))).rejects.toThrow("unexpected answer");
    await expect(misread.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-4"))).rejects.toThrow("its answer was lost");
    // A read that fails before anything was sent leaves nothing to fear.
    const lookup = await setup(`export default { video: { async start(input, host) {
      await host.fetch("https://api.flow.example/v1/quota");
      return { error: "unreachable" };
    } } };`, { media: VIDEO_MEDIA, reply: (url) => { if (url.endsWith("/quota")) throw new TypeError("socket hang up"); return undefined; } });
    await expect(lookup.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-5"))).rejects.toThrow("could not be reached");
    await expect(lookup.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-5"))).rejects.toThrow("could not be reached");
    // Done, but the download failed: a retry checks the task again instead of starting one.
    let down = true;
    const { media, requests } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, reply: (url) => down && url.endsWith(".mp4") ? new Response("busy", { status: 503 }) : undefined });
    await expect(media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-6"))).rejects.toThrow("answered 503");
    down = false;
    expect((await media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-6"))).bytes).toEqual(MP4);
    expect(requests.filter((request) => request.url === "https://api.flow.example/v1/videos")).toHaveLength(1);
    // A vendor that answered at once, with a download that failed: a retry fetches the same result, not a new one.
    let gone = true;
    const direct = await setup(`export default { video: { async start(input, host) {
      await host.fetch("https://api.flow.example/v1/videos", { method: "POST", auth: true });
      return { outputs: [{ url: "https://cdn.flow.example/now.mp4" }] };
    } } };`, { media: VIDEO_MEDIA, reply: (url) => gone && url.endsWith(".mp4") ? new Response("busy", { status: 503 }) : undefined });
    await expect(direct.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-9"))).rejects.toThrow("answered 503");
    gone = false;
    expect((await direct.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-9"))).bytes).toEqual(MP4);
    expect(direct.requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/videos", "https://cdn.flow.example/now.mp4", "https://cdn.flow.example/now.mp4"]);
    // A check that failed once (a network blip) is tried again: the task goes on, not cancelled.
    let blips = 0;
    const flaky = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, reply: (url) => {
      if (url === "https://api.flow.example/v1/videos/t1" && blips++ === 0) throw new TypeError("socket hang up");
      return undefined;
    } });
    expect((await flaky.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-8"))).bytes).toEqual(MP4);
    expect(flaky.requests.map((request) => request.url).filter((url) => url === "https://api.flow.example/v1/videos" || url.endsWith("/cancel"))).toEqual(["https://api.flow.example/v1/videos"]);
  }, 20_000);

  it("won't check a task with another account's key", async () => {
    const first = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, key: "sk-one" });
    const model = await firstVideo(first.media);
    const controller = new AbortController();
    const pending = first.media.generateVideo(model, { prompt: "a fox" }, controller.signal, await journalAt("job-7"));
    await expect.poll(() => first.requests.length).toBe(1);
    controller.abort(new GenerationShutdown());
    await expect(pending).rejects.toBeInstanceOf(GenerationShutdown);
    const other = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, key: "sk-two" });
    await expect(other.media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt("job-7"))).rejects.toThrow("its key or the request changed");
    expect(other.requests).toEqual([]);
  });

  it("keeps the task after repeated poll errors without cancelling or resubmitting it", async () => {
    let offline = true;
    const { media, requests } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, reply: (url) => {
      if (offline && url.endsWith("/t1")) throw new TypeError("offline");
      return undefined;
    } });
    const model = await firstVideo(media);
    await expect(media.generateVideo(model, { prompt: "fox" }, undefined, await journalAt())).rejects.toThrow("could not be reached");
    expect(requests.filter((r) => r.url.endsWith("/cancel"))).toEqual([]);
    offline = false;
    const journal = await journalAt();
    expect((await media.generateVideo(model, { prompt: "fox" }, undefined, journal)).bytes).toEqual(MP4);
    expect(requests.filter((r) => r.url.endsWith("/videos"))).toHaveLength(1);
  });

  it("waits for the cancellation attempt and checks the retained task on retry", async () => {
    let releaseCancel!: () => void;
    const cancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const { media, requests } = await setup(VIDEO_TASK.replaceAll("retryAfter: 0", "retryAfter: 1"), {
      media: VIDEO_MEDIA,
      reply: (url) => url.endsWith("/cancel") ? cancel.then(() => Response.json({})) : undefined,
    });
    const model = await firstVideo(media);
    const controller = new AbortController();
    const first = media.generateVideo(model, { prompt: "a fox" }, controller.signal, await journalAt());
    const stopped = expect(first).rejects.toThrow("stopped by the person");
    try {
      await expect.poll(() => requests.length).toBe(1);
      controller.abort(new Error("stopped by the person"));
      await expect.poll(() => requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/videos", "https://api.flow.example/v1/videos/t1/cancel"]);
      await expect(media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt())).rejects.toThrow("still stopping");
    } finally { releaseCancel(); await stopped; }
    // A successful cancel call alone does not establish the remote task's terminal state.
    expect((await media.generateVideo(model, { prompt: "a fox" }, undefined, await journalAt())).bytes).toEqual(MP4);
    expect(requests.filter((r) => r.url.endsWith("/videos"))).toHaveLength(1);
  });

  it("keeps a paid result if the person stops its download", async () => {
    const controller = new AbortController();
    let stop = true;
    const { media, requests } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA, reply: (url) => {
      if (url.endsWith(".mp4") && stop) { controller.abort(new Error("stop download")); throw controller.signal.reason; }
      return undefined;
    } });
    const model = await firstVideo(media);
    await expect(media.generateVideo(model, { prompt: "fox" }, controller.signal, await journalAt())).rejects.toThrow("stop download");
    stop = false;
    expect((await media.generateVideo(model, { prompt: "fox" }, undefined, await journalAt())).bytes).toEqual(MP4);
    expect(requests.filter((r) => r.url.endsWith("/videos"))).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith("/cancel"))).toEqual([]);
  });

  it("joins the video catalog and takes requests for its models", async () => {
    const { media } = await setup(VIDEO_TASK, { media: VIDEO_MEDIA });
    const videos = new ProviderVideos(async () => { throw new Error("no runtime"); }, fetch, () => undefined, () => true, { pluginVideos: media });
    const catalog = await videos.catalog();
    expect(catalog.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["plugin.acme.flow.flow/wan"]);
    expect(catalog.providers).toEqual([{ provider: "plugin.acme.flow.flow", providerName: "Flow", state: "ready" }]);
    const video = await videos.generate({ prompt: "a fox", model: { provider: "plugin.acme.flow.flow", id: "wan" }, duration: 5, resolution: "720p", aspectRatio: "16:9" });
    expect(video.mediaType).toBe("video/mp4");
    await expect(videos.generate({ prompt: "a fox", model: { provider: "plugin.acme.flow.flow", id: "nope" } })).rejects.toThrow("not available");
  }, 15_000);
});

/** A tenth of a second of silence: 16-bit mono PCM at 8 kHz. */
function wav(): Buffer {
  const samples = Buffer.alloc(1600);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}
const WAV = wav();
const GLB = (() => { const glb = Buffer.alloc(20); glb.write("glTF", 0, "ascii"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(20, 8); return glb; })();

const AUDIO_MEDIA = { audio: { models: [
  { id: "voice", title: "Voice", kinds: ["speech"], readsText: true, voices: [{ id: "amy", name: "Amy" }, { id: "bo", name: "Bo" }], formats: ["wav"], maxTextCharacters: 100 },
  { id: "foley", title: "Foley", kinds: ["sound-effect", "music"], formats: ["wav"], minDurationSeconds: 1, maxDurationSeconds: 10, loop: true },
] } } as unknown as Partial<Media>;

// Answers at once with the file, saying what it was asked for in the address.
const AUDIO_START = `export default { audio: { async start(input, host) {
  await host.fetch("https://api.flow.example/v1/audio", { method: "POST", auth: true, json: input });
  return { outputs: [{ url: "https://cdn.flow.example/" + input.model + ".wav" }] };
} } };`;

describe("plugin media providers: audio", () => {
  it("retains configured default voices across updates and reloads without adding a reference speaker to prompt audio", async () => {
    const file = path.join(root, "configuration.json"), values = new PluginValues(file);
    await values.load();
    const options = {
      values,
      configuration: { speaker: { type: "text" as const, title: "Default voice", default: "provider-default" } },
      media: { audio: { defaultVoiceSetting: "speaker", models: [
        { id: "speech", kinds: ["speech"], readsText: true, speaker: true, formats: ["wav"] },
        { id: "scene", kinds: ["music"], speaker: true, formats: ["wav"] },
      ] } } as unknown as Partial<Media>,
      reply: (url: string) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined,
    };
    const first = await setup(AUDIO_START, options);
    await values.update(first.entry, { apiKey: "private-key", speaker: "S_saved" });
    const audio = new ProviderAudio(async () => first.media.audioAdapters(() => true));
    expect((await audio.catalog()).providers[0]!.defaultVoiceId).toBe("S_saved");
    const input = { prompt: "hello" };
    await audio.generate(input);
    await audio.generate({ prompt: "hello", voiceId: "explicit" });
    await audio.generate({ prompt: "music", kind: "music" });
    expect(first.requests.filter(request => request.method === "POST").map(request => JSON.parse(request.body!).voiceId)).toEqual(["S_saved", "explicit", undefined]);
    expect(input).toEqual({ prompt: "hello" });
    await values.update(first.entry, { speaker: "S_changed" });
    expect((await audio.catalog()).providers[0]!.defaultVoiceId).toBe("S_changed");
    const reloaded = new PluginValues(file); await reloaded.load();
    const next = await setup(AUDIO_START, { ...options, values: reloaded });
    const restarted = new ProviderAudio(async () => next.media.audioAdapters(() => true));
    await restarted.generate(input);
    expect(JSON.parse(next.requests[0]!.body!).voiceId).toBe("S_changed");
    await reloaded.update(next.entry, { speaker: null });
    expect((await restarted.catalog()).providers[0]!.defaultVoiceId).toBe("provider-default");
    await reloaded.update(next.entry, { speaker: "../invalid" });
    expect((await restarted.catalog()).providers[0]!.defaultVoiceId).toBe("../invalid");
    next.requests.length = 0;
    await expect(restarted.generate(input)).rejects.toThrow("Invalid speaker ID");
    expect(next.requests).toHaveLength(0);
    await restarted.generate({ ...input, voiceId: "explicit" });
    expect(JSON.parse(next.requests[0]!.body!).voiceId).toBe("explicit");
    expect(JSON.stringify(await restarted.catalog())).not.toContain("private-key");
  });

  it.each(["json", "jsonl"] as const)("keeps %s Base64 audio, usage and generated request identity in a small resumable receipt", async format => {
    const bytes = Buffer.concat([WAV.subarray(0, 44), Buffer.alloc(2 * 1024 * 1024, 0xa5)]);
    bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", {
        method: "POST", auth: true, json: input, responseType: "file", requestIdHeader: "X-Api-Request-Id",
        decode: { format: "${format}", audioField: "audio", statusField: "code", successCodes: [0, 20000000] }
      });
      if (response.metadata.audio || response.headers["x-tt-logid"] !== "trace-[key]" || response.metadata.message !== "[key]") throw new Error("Unsafe metadata");
      return { outputs: [{ ...await response.file(), requestId: response.requestId, usageCharacters: response.metadata.usage.text_words, originalDurationMs: Math.round(response.metadata.original_duration * 1000) }] };
    } } };`;
    const body = format === "json"
      ? JSON.stringify({ code: 0, audio: bytes.toString("base64"), usage: { text_words: 0 }, original_duration: 1.2, message: "private-key" })
      : [JSON.stringify({ code: 0, audio: bytes.subarray(0, 1024).toString("base64") }), JSON.stringify({ code: 0, audio: bytes.subarray(1024).toString("base64") }), JSON.stringify({ code: 20000000, usage: { text_words: 0 }, original_duration: 1.2, message: "private-key" })].join("\r\n");
    const first = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => new Response(body, { headers: { "x-tt-logid": "trace-private-key" } }) });
    const audio = new ProviderAudio(async () => first.media.audioAdapters(() => true));
    const input = { prompt: "hello" };
    const result = await audio.generate(input, undefined, await journalAt());
    const id = first.requests[0]!.headers["x-api-request-id"];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.metadata).toMatchObject({ providerRequestId: id, usageCharacters: 0, originalDurationMs: 1200 });
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    const receipt = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(Buffer.byteLength(receipt)).toBeLessThan(4096);
    expect(receipt).not.toContain("private-key");
    const restarted = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => { throw new Error("must not pay again"); } });
    const restored = await new ProviderAudio(async () => restarted.media.audioAdapters(() => true)).generate(input, undefined, await journalAt());
    expect(Buffer.from(restored.bytes).equals(bytes)).toBe(true);
    expect(restored.metadata).toEqual(result.metadata);
    expect(first.requests).toHaveLength(1); expect(restarted.requests).toHaveLength(0);
  });

  it("recovers nested hex audio without exposing encoded bytes or credentials to the sandbox receipt", async () => {
    const bytes = Buffer.concat([WAV.subarray(0, 44), Buffer.alloc(2 * 1024 * 1024, 0xa5)]);
    bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", {
        method: "POST", auth: true, responseType: "file",
        decode: { format: "json", encoding: "hex", audioField: ["data", "audio"], statusField: ["base_resp", "status_code"], messageField: ["base_resp", "status_msg"], successCodes: [0] }
      });
      if (response.metadata.data.audio || response.metadata.data.status !== 2 || response.metadata.base_resp.status_msg !== "[key]") throw new Error("Unsafe metadata");
      return { outputs: [{ ...await response.file(), usageCharacters: response.metadata.extra_info.usage_characters }] };
    } } };`;
    const first = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => Response.json({ data: { audio: bytes.toString("hex").toUpperCase(), status: 2 }, base_resp: { status_code: 0, status_msg: "private-key" }, extra_info: { usage_characters: 2 } }) });
    const input = { prompt: "你好" };
    const result = await new ProviderAudio(async () => first.media.audioAdapters(() => true)).generate(input, undefined, await journalAt());
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(result.metadata?.usageCharacters).toBe(2);
    const receipt = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(Buffer.byteLength(receipt)).toBeLessThan(4096);
    expect(receipt).not.toContain("private-key");
    const restarted = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => { throw new Error("must not pay again"); } });
    const restored = await new ProviderAudio(async () => restarted.media.audioAdapters(() => true)).generate(input, undefined, await journalAt());
    expect(Buffer.from(restored.bytes).equals(bytes)).toBe(true);
    expect(first.requests).toHaveLength(1); expect(restarted.requests).toHaveLength(0);
  });

  it.each([
    { data: { audio: "010" }, base_resp: { status_code: 0 } },
    { data: { audio: "01xz" }, base_resp: { status_code: 0 } },
    { data: { audio: "0102" }, base_resp: { status_code: "0" } },
    { data: null, base_resp: { status_code: 0 } },
    { data: { audio: "0102" }, base_resp: null },
    { data: { audio: "0102" }, base_resp: { status_code: 1008, status_msg: "quota private-key" } },
  ])("rejects malformed or failed hex responses without resubmission: %#", async body => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", auth: true, responseType: "file",
        decode: { format: "json", encoding: "hex", audioField: ["data", "audio"], statusField: ["base_resp", "status_code"], messageField: ["base_resp", "status_msg"], successCodes: [0] } });
      return { outputs: [await response.file()] };
    } } };`;
    const { media, requests } = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => Response.json(body) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    const error = await audio.generate({ prompt: "hi" }, undefined, await journalAt()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-key");
    if (body.base_resp?.status_code === 1008) expect((error as Error).message).toContain("quota [key]");
    await expect(audio.generate({ prompt: "hi" }, undefined, await journalAt())).rejects.toThrow("response was lost");
    expect(requests).toHaveLength(1);
  });

  it("re-enters a confirmed encoded response after interruption without changing its UUID or sending again", async () => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", responseType: "file", requestIdHeader: "X-Api-Request-Id",
        decode: { format: "json", audioField: "audio", statusField: "code", successCodes: [0] } });
      await host.fetch("https://api.flow.example/ready");
      return { outputs: [{ ...await response.file(), requestId: response.requestId }] };
    } } };`;
    const first = await setup(source, { media: AUDIO_MEDIA, reply: url => {
      if (url.endsWith("/ready")) throw new Error("interrupted after confirmed receipt");
      return Response.json({ code: 0, audio: WAV.toString("base64") });
    } });
    await expect(new ProviderAudio(async () => first.media.audioAdapters(() => true)).generate({ prompt: "hi" }, undefined, await journalAt())).rejects.toThrow();
    const id = first.requests[0]!.headers["x-api-request-id"];
    expect(first.requests.map(request => request.method)).toEqual(["POST", "GET"]);
    const restarted = await setup(source, { media: AUDIO_MEDIA, reply: url => {
      if (!url.endsWith("/ready")) throw new Error("no second paid request");
      return Response.json({ ready: true });
    } });
    const result = await new ProviderAudio(async () => restarted.media.audioAdapters(() => true)).generate({ prompt: "hi" }, undefined, await journalAt());
    expect(result.metadata?.providerRequestId).toBe(id);
    expect(Buffer.from(result.bytes).equals(WAV)).toBe(true);
    expect(restarted.requests.map(request => request.method)).toEqual(["GET"]);
  });

  it.each(["usageCharacters", "originalDurationMs"].flatMap(field => [-1, 0.5, "12", Number.MAX_SAFE_INTEGER + 1].map(value => ({ field, value }))))("rejects invalid audio billing metadata without another paid request: $field=$value", async ({ field, value }) => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", responseType: "file" });
      return { outputs: [{ ...await response.file(), ${JSON.stringify(field)}: ${JSON.stringify(value)} }] };
    } } };`;
    const { media, requests } = await setup(source, { media: AUDIO_MEDIA, reply: () => new Response(new Uint8Array(WAV)) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(audio.generate({ prompt: "hi" }, undefined, await journalAt())).rejects.toThrow(field === "usageCharacters" ? "invalid character usage" : "invalid original duration");
    expect(requests).toHaveLength(1);
  });

  it.each([
    '{"code":0,"data":"!!!!"}',
    '{"code":0,"data":"AAAA"}\n{"code":403,"message":"private-key"}',
    '{"code":0,"data":"AAAA"}\n{"code":',
    '{"data":"AAAA"}',
    '{"code":"0","data":"AAAA"}',
    '{"code":0}',
    JSON.stringify({ code: 0, data: "AAAA", extra: "x".repeat(8193) }),
  ])("refuses invalid or rejected encoded audio without replaying a paid request: %#", async body => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", auth: true, responseType: "file",
        decode: { format: "jsonl", audioField: "data", statusField: "code", successCodes: [0, 20000000] } });
      return { outputs: [await response.file()] };
    } } };`;
    const { media, requests } = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => new Response(body) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    const error = await audio.generate({ prompt: "hi" }, undefined, await journalAt()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-key");
    await expect(audio.generate({ prompt: "hi" }, undefined, await journalAt())).rejects.toThrow("response was lost");
    expect(requests).toHaveLength(1);
  });

  it("bounds encoded/decoded bytes, cancels rejected streams and handles split UTF-8 and JSON lines", async () => {
    const encoding = { format: "jsonl" as const, audioField: "data", statusField: "code", successCodes: [0] };
    const raw = Buffer.from('{"code":0,"data":"AQID","message":"你好"}\n{"code":0,"data":"BAUG"}');
    const split = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    expect(await readEncodedAudio(new Response(split), encoding, 6)).toEqual({ bytes: Buffer.from([1, 2, 3, 4, 5, 6]), metadata: { code: 0, message: "你好" } });
    await expect(readEncodedAudio(new Response(raw), encoding, 5)).rejects.toThrow("Decoded audio response is too large");
    const cancelled = vi.fn();
    const oversized = new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": String(100 * 1024 * 1024) } });
    await expect(readEncodedAudio(oversized, encoding)).rejects.toThrow("Encoded audio response is too large");
    expect(cancelled).toHaveBeenCalledOnce();
    const tooMuch = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 8)); }, cancel: cancelled }));
    await expect(readEncodedAudio(tooMuch, encoding, 1)).rejects.toThrow("Encoded audio response is too large");
    expect(cancelled).toHaveBeenCalledTimes(2);
    await expect(readEncodedAudio(new Response(Uint8Array.of(0xff)), encoding)).rejects.toThrow();
  });

  it("bounds hex output and preserves nested siblings without traversing arrays or inherited fields", async () => {
    const encoding = { format: "json" as const, encoding: "hex" as const, audioField: ["data", "audio"], statusField: ["base_resp", "status_code"], successCodes: [0] };
    const body = { data: { audio: "0001aAFF", status: 2 }, base_resp: { status_code: 0 } };
    expect(await readEncodedAudio(Response.json(body), encoding, 4)).toEqual({ bytes: Buffer.from([0, 1, 170, 255]), metadata: { data: { status: 2 }, base_resp: { status_code: 0 } } });
    await expect(readEncodedAudio(Response.json(body), encoding, 3)).rejects.toThrow("Decoded audio response is too large");
    await expect(readEncodedAudio(Response.json({ ...body, data: [{ audio: "0102" }] }), encoding)).rejects.toThrow("contains no audio");
    const cancelled = vi.fn();
    const oversized = new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": String(8 * 1024 * 1024 + 9) } });
    await expect(readEncodedAudio(oversized, encoding, 4)).rejects.toThrow("Encoded audio response is too large");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    { decode: { format: "json", audioField: "audio", statusField: "code", successCodes: [] } },
    { decode: { format: "json", audioField: "audio", statusField: "audio", successCodes: [0] } },
    ...[
      { encoding: "rot13" }, { audioField: [] }, { audioField: ["a", "b", "c", "d", "e"] },
      { audioField: ["data", "__proto__"] }, { audioField: ["constructor", "audio"] },
      { audioField: ["data", "audio"], statusField: ["data"] },
      { audioField: ["data"], statusField: ["data", "code"] }, { messageField: ["data", "prototype"] },
    ].map(overrides => ({ decode: { format: "json", audioField: "audio", statusField: "code", successCodes: [0], ...overrides } })),
    { requestIdHeader: "authorization" },
    { requestIdHeader: "x-existing", headers: { "X-Existing": "value" } },
  ])("rejects invalid encoded response or request identity options before HTTP: %#", async options => {
    const source = `export default { audio: { async start(input, host) {
      await host.submit("speech", "https://api.flow.example/speech", { method: "POST", responseType: "file", ...${JSON.stringify(options)} });
      return { error: "should not send" };
    } } };`;
    const { media, requests } = await setup(source, { media: AUDIO_MEDIA });
    await expect(new ProviderAudio(async () => media.audioAdapters(() => true)).generate({ prompt: "hi" }, undefined, await journalAt())).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("passes declared speech controls and custom voices without changing saved options", async () => {
    const { media, requests } = await setup(AUDIO_START, { media: { audio: { models: [{
      id: "speech", kinds: ["speech"], readsText: true, formats: ["wav"],
      voices: [{ id: "preset", name: "Preset" }], speaker: true, pitch: true,
      volume: true, style: true, ssml: true, speechOptions: true,
    }] } } as unknown as Partial<Media>, reply: url => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.catalog()).models[0]!.capabilities).toMatchObject({
      supportsSpeaker: true, supportsPitch: true, supportsVolume: true,
      supportsStyle: true, supportsSSML: true, supportsSpeechOptions: true,
    });
    const input = {
      prompt: "你好", voiceId: "S_custom-voice", voiceKind: "cloned" as const,
      voiceModel: "expressive" as const, autoLanguage: false, dialect: "yue",
      pitch: 0, volume: -10, style: "calm", ssml: "<speak>你好</speak>",
      pronunciation: [{ word: "重", replacement: "chong2" }], silenceMs: 0,
      sectionId: "scene-1", output: { format: "wav" as const, bitRate: 64_000 },
    };
    const saved = structuredClone(input);
    await audio.generate(input);
    expect(JSON.parse(requests.find(request => request.url.endsWith("/v1/audio"))!.body!)).toMatchObject({
      model: "speech", kind: "speech", prompt: "你好", format: "wav",
      voiceId: "S_custom-voice", voiceKind: "cloned", voiceModel: "expressive",
      autoLanguage: false, dialect: "yue", pitch: 0, volume: -10, style: "calm",
      ssml: "<speak>你好</speak>", pronunciation: [{ word: "重", replacement: "chong2" }],
      silenceMs: 0, sectionId: "scene-1", bitRate: 64_000,
    });
    expect(input).toEqual(saved);
    requests.length = 0;
    for (const voiceId of ["../secret", "x".repeat(257)])
      await expect(audio.generate({ ...input, voiceId })).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toHaveLength(0);
  });

  it("retains reference speakers and rate for prompt audio while omitting undeclared speech controls", async () => {
    const { media, requests } = await setup(AUDIO_START, { media: { audio: { models: [{
      id: "scene", kinds: ["speech", "sound-effect", "music"], formats: ["wav"],
      speaker: true, pitch: true, volume: true, style: true, speedRange: [-50, 100],
    }] } } as unknown as Partial<Media>, reply: url => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    await audio.generate({ prompt: "A calm song", kind: "music", voiceId: "speaker-1", speed: 20, pitch: 2, volume: 0, style: "soft", ssml: "saved SSML", autoLanguage: true, pronunciation: [{ word: "word", replacement: "sound" }], output: { bitRate: 64_000 } });
    expect(JSON.parse(requests.find(request => request.url.endsWith("/v1/audio"))!.body!)).toEqual({
      model: "scene", kind: "music", prompt: "A calm song", format: "wav",
      voiceId: "speaker-1", speed: 20, pitch: 2, volume: 0, style: "soft",
    });
    requests.length = 0;
    await expect(audio.generate({ prompt: "song", kind: "music", speed: 101 })).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toHaveLength(0);
  });

  it("transcribes through host-owned multipart input without advertising speech generation", async () => {
    const source = `export default { audio: { async transcribe(input, host) {
      if (input.audio.base64 || input.audio.byteLength !== ${WAV.length}) throw new Error("Expected a host-owned audio input");
      const result = await (await host.fetch("https://api.flow.example/transcribe", { method: "POST", auth: true, multipart: [
        { name: "model_id", value: input.model }, { name: "language", value: input.language }, { name: "file", file: input.audio.file }
      ] })).json();
      return { text: result.text, language: result.language };
    } } };`;
    const { media, requests } = await setup(source, { media: { audio: { models: [{ id: "scribe", kinds: [], transcribes: true }] } } as unknown as Partial<Media>, reply: () => Response.json({ text: "  你好世界  ", language: "zh" }) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.catalog()).models[0]!.capabilities).toMatchObject({ produces: [], transcribes: true });
    expect(await audio.resolveModel()).toBeUndefined();
    expect(await audio.transcribe({ bytes: WAV, mediaType: "audio/wav", name: "声音.wav", language: "zh-CN" })).toEqual({ text: "你好世界", language: "zh", model: { provider: "plugin.acme.flow.flow", id: "scribe" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(requests[0]!.form!.get("model_id")).toBe("scribe");
    expect(requests[0]!.form!.get("language")).toBe("zh-CN");
    const file = requests[0]!.form!.get("file") as File;
    expect(Buffer.from(await file.arrayBuffer())).toEqual(WAV);
    expect(file.type).toBe("audio/wav");
    const library = new AssetLibrary(root); await library.load();
    const projects = new ProjectManager(root, library); await projects.load();
    const project = await projects.create("Transcription", "asset-canvas");
    const id = (await library.add("line.wav", WAV)).id, count = library.list().length;
    const app = Fastify();
    const store = registerCanvasRoutes(app, { projects, library, tools: new ToolRunner(root, { generate: async () => { throw new Error("Unexpected generation"); } }, undefined, undefined, library), audio });
    try {
      const response = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: { operation: "transcribe-audio", assetIds: [id], options: { language: "zh-CN" } } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ kind: "text", text: "你好世界" });
      expect(library.list()).toHaveLength(count);
      expect(requests).toHaveLength(2);
    } finally { await app.close(); await store.close(); }
  }, 15_000);

  it("bounds transcription inputs and rechecks cached provider access before upload", async () => {
    const options = { allowed: true, media: { audio: { models: [{ id: "scribe", kinds: [], transcribes: true }] } } as unknown as Partial<Media> };
    const { media, requests } = await setup(`export default { audio: { transcribe() { return { text: "hello" }; } } };`, options);
    const [adapter] = await media.audioAdapters(() => true);
    const input = { bytes: WAV, mediaType: "audio/wav", name: "input.wav", model: { provider: "plugin.acme.flow.flow", id: "scribe" } };
    for (const change of [{ bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(64 * 1024 * 1024 + 1) }])
      await expect(adapter!.transcribe!({ ...input, ...change })).rejects.toMatchObject({ statusCode: 413 });
    for (const change of [{ mediaType: "text/plain" }, { language: "x".repeat(41) }, { model: { ...input.model, id: "not-scribe" } }])
      await expect(adapter!.transcribe!({ ...input, ...change })).rejects.toMatchObject({ statusCode: 400 });
    await expect(adapter!.transcribe!(input, AbortSignal.abort(new Error("already stopped")))).rejects.toThrow("already stopped");
    options.allowed = false;
    await expect(adapter!.transcribe!(input)).rejects.toMatchObject({ statusCode: 503 });
    options.allowed = true;
    expect(await adapter!.transcribe!(input)).toMatchObject({ text: "hello" });
    expect(requests).toHaveLength(0);
  });

  it("validates bounded transcript replies and permits silence as an empty transcript", async () => {
    for (const result of [{ text: 3 }, { text: "x", language: {} }, { text: "x", language: "x".repeat(41) }, { error: "vendor refused" }, { text: "x".repeat(1_000_001) }, { text: "   " }]) {
      const { media } = await setup(`export default { audio: { transcribe() { return ${typeof result.text === "string" && result.text.length > 1_000_000 ? '{ text: "x".repeat(1000001) }' : JSON.stringify(result)}; } } };`, { media: { audio: { models: [{ id: "scribe", kinds: [], transcribes: true }] } } as unknown as Partial<Media> });
      const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
      const answer = audio.transcribe({ bytes: WAV, mediaType: "audio/wav", name: "input.wav" });
      if (result.text === "   ") expect(await answer).toMatchObject({ text: "" });
      else await expect(answer).rejects.toMatchObject({ statusCode: 502 });
    }
  });

  it("does not retry failed transcription requests or permit paid-step replay or foreign file handles", async () => {
    for (const request of [
      'host.fetch("https://api.flow.example/transcribe", { method: "POST", multipart: [{ name: "file", file: input.audio.file }] })',
      'host.submit("transcribe", "https://api.flow.example/transcribe", { method: "POST" })',
      'host.reuse("transcribe")',
      'host.fetch("https://api.flow.example/transcribe", { method: "POST", multipart: [{ name: "file", file: "../../private" }] })',
      'host.fetch("https://api.flow.example/transcribe", { method: "POST", responseType: "file" })',
    ]) {
      const { media, requests } = await setup(`export default { audio: { async transcribe(input, host) { await ${request}; return { text: "unexpected" }; } } };`, {
        media: { audio: { models: [{ id: "scribe", kinds: [], transcribes: true }] } } as unknown as Partial<Media>, reply: () => { throw new Error("lost response"); },
      });
      const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
      await expect(audio.transcribe({ bytes: WAV, mediaType: "audio/wav", name: "input.wav" })).rejects.toMatchObject({ statusCode: 502 });
      expect(requests).toHaveLength(request.includes("file: input.audio.file") ? 1 : 0);
    }
  });

  it("cancels one active transcription without cancelling an independent upload", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { media, requests } = await setup(`export default { audio: { async transcribe(input, host) {
      return await (await host.fetch("https://api.flow.example/" + input.language, { method: "POST", multipart: [{ name: "file", file: input.audio.file }] })).json();
    } } };`, { media: { audio: { models: [{ id: "scribe", kinds: [], transcribes: true }] } } as unknown as Partial<Media>, reply: (url, signal) => {
      if (url.endsWith("/en")) return new Promise<Response>((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); entered(); });
      return Response.json({ text: "你好", language: "zh" });
    } });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    const input = { bytes: WAV, mediaType: "audio/wav", name: "input.wav" }, controller = new AbortController();
    const first = audio.transcribe({ ...input, language: "en" }, controller.signal);
    const rejected = expect(first).rejects.toThrow("stop one transcription");
    await started;
    const second = audio.transcribe({ ...input, language: "zh" });
    controller.abort(new Error("stop one transcription"));
    await rejected;
    expect(await second).toMatchObject({ text: "你好" });
    expect(requests).toHaveLength(2);
  });

  it("ends a slow transcription at its deadline without retrying the upload", async () => {
    let entered!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
    const { media, requests } = await setup(`export default { audio: { async transcribe(input, host) {
      return await (await host.fetch("https://api.flow.example/transcribe", { method: "POST", multipart: [{ name: "file", file: input.audio.file }] })).json();
    } } };`, { media: { audio: { models: [{ id: "scribe", kinds: [], transcribes: true }] } } as unknown as Partial<Media>, reply: (_url, signal) => new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); entered(signal!);
    }) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true)), controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const timed = new AbortController(); setTimeout(() => timed.abort(new DOMException("Timed out", "TimeoutError")), ms); return timed.signal;
    });
    const result = audio.transcribe({ bytes: WAV, mediaType: "audio/wav", name: "input.wav" }, controller.signal).catch((error: unknown) => error);
    try {
      const signal = await started;
      await vi.advanceTimersByTimeAsync(290_000); expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(11_000); expect(signal.aborted).toBe(true);
      expect(await result).toMatchObject({ statusCode: 504 });
      expect(requests).toHaveLength(1);
    } finally { controller.abort(); await result; timeout.mockRestore(); vi.useRealTimers(); }
  });

  it.each(["complete", "cancel", "timeout"])("allows a slow binary audio response and handles %s without replay", async ending => {
    let entered!: (signal: AbortSignal) => void, finish!: () => void;
    const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
    const source = `export default { audio: { async start(input, host) {
      return { outputs: [await (await host.submit("speech", "https://api.flow.example/speech", { method: "POST", responseType: "file" })).file()] };
    } } };`;
    const { media, requests } = await setup(source, { media: AUDIO_MEDIA, reply: (_url, signal) => new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      finish = () => { signal!.removeEventListener("abort", abort); resolve(new Response(new Uint8Array(WAV))); };
      signal!.addEventListener("abort", abort, { once: true }); entered(signal!);
    }) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    const controller = new AbortController(), journal = await journalAt();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const timed = new AbortController(); setTimeout(() => timed.abort(new DOMException("Timed out", "TimeoutError")), ms); return timed.signal;
    });
    const result = audio.generate({ prompt: "hello" }, controller.signal, journal).then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      const signal = await started;
      await vi.advanceTimersByTimeAsync(290_000);
      expect(signal.aborted).toBe(false);
      if (ending === "complete") {
        finish(); expect(await result).toMatchObject({ value: { bytes: WAV } });
      } else {
        if (ending === "cancel") controller.abort(new Error("user stopped"));
        else await vi.advanceTimersByTimeAsync(11_000);
        expect(signal.aborted).toBe(true); expect(await result).toEqual({ error: expect.any(Error) });
        await journal.settled();
        await expect(audio.generate({ prompt: "hello" }, undefined, await journalAt())).rejects.toThrow("response was lost");
      }
      expect(requests).toHaveLength(1);
    } finally {
      controller.abort(new Error("test cleanup")); finish?.(); await result; await journal.settled();
      timeout.mockRestore(); vi.useRealTimers();
    }
  });

  it("stores binary audio outside the sandbox and resumes it without another paid request", async () => {
    const bytes = Buffer.concat([WAV.subarray(0, 44), Buffer.alloc(2 * 1024 * 1024, 0xa5)]);
    bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", auth: true, json: input, responseType: "file" });
      return { outputs: [{ ...await response.file(), requestId: response.headers["request-id"] }] };
    } } };`;
    const first = await setup(source, { media: AUDIO_MEDIA, reply: () => new Response(new Uint8Array(bytes), { headers: { "content-type": "audio/wav", "request-id": "audio-request-1" } }) });
    const audio = new ProviderAudio(async () => first.media.audioAdapters(() => true));
    const input = { prompt: "hello" };
    const firstResult = await audio.generate(input, undefined, await journalAt());
    expect(Buffer.from(firstResult.bytes).equals(bytes)).toBe(true);
    expect(firstResult.metadata?.providerRequestId).toBe("audio-request-1");
    const receipt = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(Buffer.byteLength(receipt)).toBeLessThan(4096);
    expect(receipt).not.toContain(root);
    const restarted = await setup(source, { media: AUDIO_MEDIA, reply: () => { throw new Error("must not pay again"); } });
    const next = new ProviderAudio(async () => restarted.media.audioAdapters(() => true));
    const journal = await journalAt();
    const restored = await next.generate(input, undefined, journal);
    expect(Buffer.from(restored.bytes).equals(bytes)).toBe(true);
    expect(restored.metadata?.providerRequestId).toBe("audio-request-1");
    expect(first.requests).toHaveLength(1); expect(restarted.requests).toHaveLength(0);
    await journal.clear();
    expect(await readdir(path.join(root, "media-tasks"))).toEqual([]);
  });

  it("redacts keys in audio request IDs without exposing other response headers", async () => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", auth: true, responseType: "file" });
      if (response.headers["set-cookie"]) throw new Error("Unexpected private header");
      return { outputs: [{ ...await response.file(), requestId: response.headers["request-id"] }] };
    } } };`;
    const { media } = await setup(source, { key: "private-key", media: AUDIO_MEDIA, reply: () => new Response(new Uint8Array(WAV), { headers: { "request-id": "req-private-key", "set-cookie": "secret-cookie" } }) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.generate({ prompt: "hello" }, undefined, await journalAt())).metadata?.providerRequestId).toBe("req-[key]");
    const receipt = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(receipt).not.toContain("private-key");
    expect(receipt).not.toContain("secret-cookie");
  });

  it.each(["", " ", 42, "x".repeat(513)])("rejects invalid audio request IDs without replaying paid work: %j", async requestId => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", auth: true, responseType: "file" });
      return { outputs: [{ ...await response.file(), requestId: ${JSON.stringify(requestId)} }] };
    } } };`;
    const { media, requests } = await setup(source, { media: AUDIO_MEDIA, reply: () => new Response(new Uint8Array(WAV)) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(audio.generate({ prompt: "hello" }, undefined, await journalAt())).rejects.toThrow("invalid request ID");
    expect(requests).toHaveLength(1);
  });

  it("keeps a missing or tampered binary result without paying again", async () => {
    const source = `export default { audio: { async start(input, host) {
      return { outputs: [await (await host.submit("speech", "https://api.flow.example/speech", { method: "POST", responseType: "file" })).file()] };
    } } };`;
    const { media, requests } = await setup(source, { media: AUDIO_MEDIA, reply: () => new Response(new Uint8Array(WAV)) });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    const input = { prompt: "hello" };
    await audio.generate(input, undefined, await journalAt());
    const directory = path.join(root, "media-tasks/job-1.files"), [name] = await readdir(directory);
    const file = path.join(directory, name!);
    await writeFile(file, Buffer.alloc(WAV.length));
    await expect(audio.generate(input, undefined, await journalAt())).rejects.toThrow("saved audio result is missing, changed or unreadable");
    await rm(file);
    await expect(audio.generate(input, undefined, await journalAt())).rejects.toThrow();
    expect(requests).toHaveLength(1);
    await writeFile(file, WAV);
    expect((await audio.generate(input, undefined, await journalAt())).bytes).toEqual(WAV);
    expect(requests).toHaveLength(1);
  });

  it("rejects binary fetches without a paid owner before dispatch and keeps oversized responses ambiguous", async () => {
    const source = (method: string) => `export default { audio: { async start(input, host) {
      const response = await host.${method}("https://api.flow.example/speech", { method: "POST", responseType: "file" });
      return { outputs: [await response.file()] };
    } } };`;
    const raw = await setup(source("fetch"), { media: AUDIO_MEDIA });
    const rawAudio = new ProviderAudio(async () => raw.media.audioAdapters(() => true));
    await expect(rawAudio.generate({ prompt: "hello" })).rejects.toThrow("Binary responses require");
    expect(raw.requests).toHaveLength(0);
    const oversized = await setup(source('submit.bind(null, "speech")'), { media: AUDIO_MEDIA, reply: () => new Response("", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }) });
    const audio = new ProviderAudio(async () => oversized.media.audioAdapters(() => true));
    await expect(audio.generate({ prompt: "hello" })).rejects.toThrow("recoverable generation");
    expect(oversized.requests).toHaveLength(0);
    await expect(audio.generate({ prompt: "hello" }, undefined, await journalAt())).rejects.toThrow("more than 64 MB");
    await expect(audio.generate({ prompt: "hello" }, undefined, await journalAt())).rejects.toThrow("response was lost");
    expect(oversized.requests).toHaveLength(1);
  });

  it("keeps binary request errors readable without exposing successful file bytes to scripts", async () => {
    const source = `export default { audio: { async start(input, host) {
      const response = await host.submit("speech", "https://api.flow.example/speech", { method: "POST", responseType: "file" });
      if (!response.ok) return { error: (await response.json()).error };
      await response.text();
      return { outputs: [await response.file()] };
    } } };`;
    const rejected = await setup(source, { media: AUDIO_MEDIA, reply: () => Response.json({ error: "not available" }, { status: 400 }) });
    const audio = new ProviderAudio(async () => rejected.media.audioAdapters(() => true));
    await expect(audio.generate({ prompt: "hello" }, undefined, await journalAt())).rejects.toThrow("not available");
    const success = await setup(source, { media: AUDIO_MEDIA, reply: () => new Response(new Uint8Array(WAV)) });
    const next = new ProviderAudio(async () => success.media.audioAdapters(() => true));
    await expect(next.generate({ prompt: "hello" }, undefined, await journalAt("binary"))).rejects.toThrow("host-owned file");
    await expect(next.generate({ prompt: "hello" }, undefined, await journalAt("binary"))).rejects.toThrow("host-owned file");
    expect(success.requests).toHaveLength(1);
  });

  it("preserves URL outputs with an unrelated file field from older adapters", async () => {
    const source = AUDIO_START.replace('outputs: [{ url:', 'outputs: [{ file: "vendor-name.wav", url:');
    const { media } = await setup(source, { media: AUDIO_MEDIA, reply: url => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.generate({ prompt: "hello" })).bytes).toEqual(WAV);
  });

  it("preserves declared speech limits and output settings through the sandbox", async () => {
    const speech = { id: "speech", kinds: ["speech"], readsText: true, voices: [{ id: "amy", name: "Amy" }], formats: ["wav"], maxTextCharacters: 40_000, speedRange: [-30, 20], languages: ["en", "zh"], sampleRatesByFormat: { wav: [8000, 24000] } };
    const { media, requests } = await setup(AUDIO_START, { media: { audio: { models: [speech] } } as unknown as Partial<Media>, reply: (url) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.catalog()).models[0]!.capabilities).toMatchObject({ maxTextCharacters: 40_000, speedRange: [-30, 20], languages: ["en", "zh"], sampleRatesByFormat: { wav: [8000, 24000] } });
    const prompt = "中".repeat(39_999) + '"';
    await audio.generate({ prompt, language: "zh", speed: 0, output: { format: "wav", sampleRate: 8000 } });
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ prompt, speed: 0, language: "zh", sampleRate: 8000 });
    requests.length = 0;
    for (const speed of [-31, 21, Number.NaN]) await expect(audio.generate({ prompt: "Hello", speed })).rejects.toMatchObject({ statusCode: 400 });
    await expect(audio.generate({ prompt: "a".repeat(40_001) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(audio.generate({ prompt: "Hello", output: { format: "wav", sampleRate: 44100 } })).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toEqual([]);
    const mismatched = { prompt: "Hello", output: { format: "wav" as const, sampleRate: 24000 as const } };
    for (let retry = 0; retry < 2; retry++)
      await expect(audio.generate(mismatched, undefined, await journalAt("audio-rate"))).rejects.toThrow("sample rate");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  }, 15_000);

  it("checks explicit output channels before payment and against the returned audio without resubmitting", async () => {
    const options = { media: { audio: { models: [{ id: "speech", kinds: ["speech"], readsText: true, formats: ["wav"], channels: [1, 2] }] } } as unknown as Partial<Media>,
      reply: (url: string) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined };
    const { media, requests } = await setup(AUDIO_START, options);
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.catalog()).models[0]!.capabilities.channels).toEqual([1, 2]);
    const input = { prompt: "hello", output: { channels: 1 as const } };
    const saved = structuredClone(input);
    expect((await audio.generate(input)).metadata?.channels).toBe(1);
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ channels: 1 });
    expect(input).toEqual(saved);
    requests.length = 0;
    for (const channels of [0, 3, 1.5, "1", null])
      await expect(audio.generate({ prompt: "hello", output: { channels: channels as 1 } })).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toHaveLength(0);
    for (let retry = 0; retry < 2; retry++)
      await expect(audio.generate({ prompt: "hello", output: { channels: 2 } }, undefined, await journalAt("stereo"))).rejects.toThrow("different channel count");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    for (const channels of [undefined, [1]]) {
      const next = await setup(AUDIO_START, { ...options, media: { audio: { models: [{ id: "speech", kinds: ["speech"], formats: ["wav"], ...(channels ? { channels } : {}) }] } } as unknown as Partial<Media> });
      const provider = new ProviderAudio(async () => next.media.audioAdapters(() => true));
      await expect(provider.generate({ prompt: "hello", output: { channels: 2 } })).rejects.toMatchObject({ statusCode: 400 });
      expect(next.requests).toHaveLength(0);
      expect((await provider.generate({ prompt: "hello" })).metadata?.channels).toBe(1);
      expect(JSON.parse(next.requests[0]!.body!)).not.toHaveProperty("channels");
    }
  });

  it("accepts fractional sound lengths and rejects non-finite or out-of-range lengths before dispatch", async () => {
    const { media, requests } = await setup(AUDIO_START, { media: { audio: { models: [{ id: "sfx", kinds: ["sound-effect"], formats: ["wav"], minDurationSeconds: 0.5, maxDurationSeconds: 30 }] } } as Partial<Media>, reply: (url) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    expect((await audio.catalog()).models[0]!.capabilities.minDurationSeconds).toBe(0.5);
    await audio.generate({ prompt: "click", durationSeconds: 0.5 });
    expect(JSON.parse(requests[0]!.body!).durationSeconds).toBe(0.5);
    requests.length = 0;
    for (const durationSeconds of [0.49, 30.01, Number.NaN, Infinity]) await expect(audio.generate({ prompt: "click", durationSeconds })).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toEqual([]);
  }, 15_000);

  it("lists account voices with search and pagination without choosing a default", async () => {
    const adapter = `export default { audio: {
      async voices(query, host) { return (await host.fetch("https://api.flow.example/voices?search=" + encodeURIComponent(query.search || "") + "&page=" + encodeURIComponent(query.pageToken || ""), { auth: true })).json(); },
      async start(input, host) { await host.fetch("https://api.flow.example/v1/audio", { method: "POST", auth: true, json: input }); return { outputs: [{ url: "https://cdn.flow.example/voice.wav" }] }; }
    } };`;
    const page = { voices: [{ id: "account-voice", name: "My voice", previewUrl: "https://cdn.flow.example/preview.mp3", labels: { language: "zh" } }], nextPageToken: "page-2" };
    const { media, requests } = await setup(adapter, { media: { audio: { ...AUDIO_MEDIA.audio!, listVoices: true } } as unknown as Partial<Media>, reply: url => url.includes("/voices?") ? Response.json(page) : url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true)), provider = "plugin.acme.flow.flow";
    const catalog = await audio.catalog();
    expect(catalog.providers[0]).not.toHaveProperty("defaultVoiceId");
    expect(catalog.models[0]!.capabilities).toMatchObject({ supportsSpeaker: true, requiresVoice: true });
    expect(await audio.voices(provider, { search: "我的 voice", pageToken: "page-1" })).toEqual(page);
    expect(new URL(requests[0]!.url).searchParams.get("search")).toBe("我的 voice");
    expect(new URL(requests[0]!.url).searchParams.get("page")).toBe("page-1");
    expect(requests[0]!.headers.authorization).toBe("Bearer sk-test");
    requests.length = 0;
    await expect(audio.generate({ prompt: "Hello" })).rejects.toMatchObject({ statusCode: 400 });
    expect(requests).toEqual([]);
    await audio.generate({ prompt: "Hello", voiceId: "account-voice" });
    expect(JSON.parse(requests[0]!.body!).voiceId).toBe("account-voice");
  }, 15_000);

  it("rejects writes, malformed pages and unapproved previews in account voice queries", async () => {
    const declarations = { audio: { ...AUDIO_MEDIA.audio!, listVoices: true } } as unknown as Partial<Media>;
    const pages = [null, { voices: "bad" }, { voices: [{ id: "a", name: "A" }, { id: "a", name: "Again" }] }, { voices: [{ id: "a", name: "A", previewUrl: "https://unapproved.example/a.mp3" }] }, { voices: [{ id: "a", name: "A", previewUrl: "http://cdn.flow.example/a.mp3" }] }, { voices: [], nextPageToken: "x".repeat(2001) }];
    for (const page of pages) {
      const { media, requests } = await setup(`export default { audio: { voices() { return ${JSON.stringify(page)}; } } };`, { media: declarations });
      const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
      await expect(audio.voices("plugin.acme.flow.flow", {})).rejects.toMatchObject({ statusCode: 502 });
      expect(requests).toEqual([]);
    }
    const { media, requests } = await setup(`export default { audio: { async voices(query, host) { await host.fetch("https://api.flow.example/delete", { method: "POST", auth: true }); return { voices: [] }; } } };`, { media: declarations });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    await expect(audio.voices("plugin.acme.flow.flow", {})).rejects.toThrow("read-only");
    expect(requests).toEqual([]);
  }, 15_000);

  it("rechecks account voice access and does not dispatch cancelled or invalid queries", async () => {
    const options = { media: { audio: { ...AUDIO_MEDIA.audio!, listVoices: true } } as unknown as Partial<Media>, allowed: true };
    const { media, requests } = await setup(`export default { audio: { async voices(query, host) { await host.fetch("https://api.flow.example/voices", { auth: true }); return { voices: [] }; } } };`, options);
    const [adapter] = await media.audioAdapters(() => true);
    const stopped = new AbortController(); stopped.abort(new Error("closed picker"));
    await expect(adapter!.voices!({}, stopped.signal)).rejects.toThrow("closed picker");
    await expect(adapter!.voices!({ search: "x".repeat(201) })).rejects.toMatchObject({ statusCode: 400 });
    options.allowed = false;
    await expect(adapter!.voices!({})).rejects.toMatchObject({ statusCode: 503 });
    expect(requests).toEqual([]);
    options.allowed = true;
    await expect(adapter!.voices!({})).resolves.toEqual({ voices: [] });
    expect(requests).toHaveLength(1);
  }, 15_000);

  it("allows extra default voices beyond a requested page size while bounding the whole page", async () => {
    for (const count of [101, 500, 501]) {
      const voices = Array.from({ length: count }, (_, index) => ({ id: `voice-${index}`, name: `Voice ${index}` }));
      const { media } = await setup(`export default { audio: { voices() { return ${JSON.stringify({ voices })}; } } };`, { media: { audio: { ...AUDIO_MEDIA.audio!, listVoices: true } } as unknown as Partial<Media> });
      const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
      if (count <= 500) expect((await audio.voices("plugin.acme.flow.flow", {})).voices).toHaveLength(count);
      else await expect(audio.voices("plugin.acme.flow.flow", {})).rejects.toMatchObject({ statusCode: 502 });
    }
  }, 15_000);

  it("cancels an active account voice request without cancelling a separate search", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const { media } = await setup(`export default { audio: { async voices(query, host) { return (await host.fetch("https://api.flow.example/voices", { auth: true })).json(); } } };`, {
      media: { audio: { ...AUDIO_MEDIA.audio!, listVoices: true } } as unknown as Partial<Media>,
      reply: (_url, signal) => {
        if (++calls > 1) return Response.json({ voices: [] });
        entered();
        return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      },
    });
    const [adapter] = await media.audioAdapters(() => true), controller = new AbortController();
    const pending = adapter!.voices!({ search: "first" }, controller.signal);
    const rejected = expect(pending).rejects.toThrow("closed search");
    await started;
    await expect(adapter!.voices!({ search: "second" })).resolves.toEqual({ voices: [] });
    controller.abort(new Error("closed search"));
    await rejected;
  }, 15_000);

  it("lists a provider's audio models and voices, and makes speech in its first voice", async () => {
    const { media, requests } = await setup(AUDIO_START, { media: AUDIO_MEDIA, reply: (url) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const [provider] = await media.audioProviders();
    expect(provider!.voices).toEqual([{ id: "amy", name: "Amy" }, { id: "bo", name: "Bo" }]);
    const [voice, foley] = provider!.models;
    expect(voice).toEqual({ provider: "plugin.acme.flow.flow", providerName: "Flow", id: "voice", name: "Voice", protocol: "plugin",
      capabilities: { produces: ["speech"], readsText: true, supportsSpeaker: true, formats: ["wav"], maxTextCharacters: 100 } });
    const speech = await media.generateAudio(voice!, { prompt: "Hello there" });
    expect(speech).toMatchObject({ bytes: WAV, mediaType: "audio/wav", model: { provider: "plugin.acme.flow.flow", id: "voice" }, metadata: { durationMs: 100, sampleRate: 8000, channels: 1 } });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ model: "voice", kind: "speech", prompt: "Hello there", format: "wav", voiceId: "amy" });
    await media.generateAudio(voice!, { prompt: "Faster", voiceId: "bo", speed: 50 });
    expect(JSON.parse(requests[2]!.body!)).toMatchObject({ voiceId: "bo", speed: 50 });
    // A model that makes more than one kind hears which; a loop goes only where the model takes one.
    await media.generateAudio(foley!, { prompt: "rain", kind: "music", durationSeconds: 5, loop: true });
    expect(JSON.parse(requests[4]!.body!)).toEqual({ model: "foley", kind: "music", prompt: "rain", format: "wav", durationSeconds: 5, loop: true });
    await expect(media.generateAudio(voice!, { prompt: "x".repeat(101) })).rejects.toThrow("up to 100 characters");
    await expect(media.generateAudio(voice!, { prompt: "Hi", voiceId: "zed" })).rejects.toThrow("isn't one this model speaks in");
    await expect(media.generateAudio(foley!, { prompt: "rain", durationSeconds: 20 })).rejects.toThrow("1 to 10 seconds");
    await expect(media.generateAudio(voice!, { prompt: "Hi", output: { format: "mp3" } })).rejects.toThrow("doesn't make mp3");
  }, 15_000);

  it("keeps a paid result whose download failed, so a retry fetches it without starting again", async () => {
    let downloads = 0;
    const { media, requests } = await setup(AUDIO_START, { media: AUDIO_MEDIA, reply: (url) => url.endsWith(".wav") ? (++downloads === 1 ? new Response("busy", { status: 503 }) : new Response(new Uint8Array(WAV))) : undefined });
    const voice = (await media.audioProviders())[0]!.models[0]!;
    await expect(media.generateAudio(voice, { prompt: "Hello" }, undefined, await journalAt("audio-1"))).rejects.toThrow("answered 503");
    const again = await media.generateAudio(voice, { prompt: "Hello" }, undefined, await journalAt("audio-1"));
    expect(again.mediaType).toBe("audio/wav");
    expect(requests.filter((request) => request.url === "https://api.flow.example/v1/audio")).toHaveLength(1);
  }, 15_000);

  it("refuses a request without a prompt, and a length below a model's minimum", async () => {
    const minimumOnly = { audio: { models: [{ id: "long", kinds: ["music"], formats: ["wav"], minDurationSeconds: 10 }] } } as unknown as Partial<Media>;
    const { media, requests } = await setup(AUDIO_START, { media: minimumOnly });
    const audio = new ProviderAudio(async () => media.audioAdapters(() => true));
    await expect(audio.generate({ prompt: "   " })).rejects.toThrow("needs a prompt");
    await expect(audio.generate({ prompt: "a march", durationSeconds: 2 })).rejects.toThrow("10 to any number of seconds");
    expect(requests).toEqual([]);
  }, 15_000);

  it("refuses a file that isn't the audio asked for", async () => {
    const { media } = await setup(AUDIO_START, { media: AUDIO_MEDIA, reply: (url) => url.endsWith(".wav") ? new Response(new Uint8Array(PNG)) : undefined });
    const voice = (await media.audioProviders())[0]!.models[0]!;
    await expect(media.generateAudio(voice, { prompt: "Hello", output: { format: "wav" } })).rejects.toThrow("Invalid wav audio");
    await expect(media.generateAudio(voice, { prompt: "Hello" })).rejects.toThrow("Flow returned a file that isn't playable audio");
  }, 15_000);

  it("keeps the audio a model made when no format was picked, as some vendors don't say which", async () => {
    const mp3Only = { audio: { models: [{ ...(AUDIO_MEDIA.audio!.models[1]!), formats: ["mp3"] }] } } as unknown as Partial<Media>;
    const { media } = await setup(AUDIO_START, { media: mp3Only, reply: (url) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const foley = (await media.audioProviders())[0]!.models[0]!;
    expect((await media.generateAudio(foley, { prompt: "rain" })).mediaType).toBe("audio/wav");
    await expect(media.generateAudio(foley, { prompt: "rain", output: { format: "mp3" } })).rejects.toThrow("Invalid mp3 audio");
  }, 15_000);

  it("joins the audio catalog, which picks its model by kind", async () => {
    const { media } = await setup(AUDIO_START, { media: AUDIO_MEDIA, reply: (url) => url.endsWith(".wav") ? new Response(new Uint8Array(WAV)) : undefined });
    const enabled = new Set(["plugin.acme.flow.flow"]);
    const audio = new ProviderAudio(async () => media.audioAdapters((id) => enabled.has(id)));
    const catalog = await audio.catalog();
    expect(catalog.models.map((model) => model.id)).toEqual(["voice", "foley"]);
    expect(catalog.providers).toEqual([{ provider: "plugin.acme.flow.flow", name: "Flow", defaultVoiceId: "amy", listsVoices: true, configured: true, state: "ready" }]);
    expect(await audio.voices("plugin.acme.flow.flow", {})).toEqual({ voices: [{ id: "amy", name: "Amy" }, { id: "bo", name: "Bo" }] });
    expect((await audio.generate({ prompt: "rain", kind: "sound-effect" })).model).toEqual({ provider: "plugin.acme.flow.flow", id: "foley" });
    // Switched off in Settings, it leaves the catalog.
    enabled.clear();
    expect((await audio.catalog()).providers[0]!.state).toBe("disabled");
    await expect(audio.generate({ prompt: "Hi" })).rejects.toThrow("No audio model is available");
  }, 15_000);
});

const MODEL3D_MEDIA = { "3d": { models: [
  { id: "mesh", title: "Mesh", operations: ["text", "image"], maxReferenceImages: 2, polycount: { min: 1000, max: 50000, default: 10000 }, texture: true },
] } } as unknown as Partial<Media>;

// Starts a task and has the model on the first check.
const MODEL3D_TASK = `export default { "3d": {
  async start(input, host) {
    const answer = await (await host.fetch("https://api.flow.example/v1/meshes", { method: "POST", auth: true, json: { ...input, references: input.references.length } })).json();
    return { task: { id: answer.id }, retryAfter: 0 };
  },
  async check(task) { return { outputs: [{ url: "https://cdn.flow.example/" + task.id + ".glb" }] }; },
} };`;

describe("plugin media providers: 3D", () => {
  it("keeps manual versions and preset defaults across restart and passes their settings to the adapter", async () => {
    const definition = structuredClone(MODEL3D_MEDIA);
    definition["3d"]!.editableModels = true;
    definition["3d"]!.models[0]!.modelSettings = { imageOperation: "multi-image-to-3d", modelType: "standard" };
    definition["3d"]!.models[0]!.data = { opaque: { keep: true } };
    definition["3d"]!.models[0]!.referenceImageLabels = ["Front", "Left"];
    const options = { media: definition, choices: new PluginMediaModelChoices(root), reply: (url: string) => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined };
    const { media } = await setup(MODEL3D_TASK, options), provider = "plugin.acme.flow.flow";
    const original = await media.listModels(provider, "3d");
    const edited = await media.saveModel3D(provider, { revision: original.editor!.revision,
      model: { id: "mesh", title: "My preset", polycount: { min: 1000, max: 50000, default: 3000, presets: [3000] }, operations: ["text", "image"] } });
    expect(edited.models[0]).toMatchObject({ name: "My preset", edited: true, custom: false });
    await expect(media.saveModel3D(provider, { revision: original.editor!.revision, model: { ...original.models[0]!.definition! } })).rejects.toMatchObject({ statusCode: 409 });
    const manual = await media.saveModel3D(provider, { revision: edited.editor!.revision, templateId: "mesh", model: {
      id: "manual-version", title: "My version", operations: ["text", "image"], maxReferenceImages: 1,
      polycount: { min: 100, max: 15000, default: 2000, presets: [2000] }, defaults: { texture: false, pbr: false },
      modelSettings: { imageOperation: "image-to-3d", modelType: "smart-topology" },
    } });
    expect(manual.models.find(model => model.id === "manual-version")).toMatchObject({ custom: true, shown: true, definition: { maxReferenceImages: 1, referenceImageLabels: ["Front", "Left"] } });
    await media.setModelsShown(provider, "3d", ["manual-version"], false);
    const restarted = await setup(MODEL3D_TASK, { ...options, choices: new PluginMediaModelChoices(root) });
    expect((await restarted.media.model3DProviders())[0]!.models.map(model => model.id)).toEqual(["mesh"]);
    await restarted.media.setModelsShown(provider, "3d", ["manual-version"], true);
    const models = (await restarted.media.model3DProviders())[0]!.models;
    expect(models[0]).toMatchObject({ name: "My preset", polycount: { default: 3000 } });
    const model = models.find(model => model.id === "manual-version")!;
    expect(model).toMatchObject({ polycount: { default: 2000 }, defaults: { texture: false, pbr: false } });
    await restarted.media.generate3D(model, { model: { provider, id: model.id }, operation: "text", prompt: "a chair", images: [] });
    expect(JSON.parse(restarted.requests[0]!.body!)).toMatchObject({ model: "manual-version", targetPolycount: 2000, texture: false,
      modelData: { opaque: { keep: true } }, modelSettings: { imageOperation: "image-to-3d", modelType: "smart-topology" } });
    const current = await restarted.media.listModels(provider, "3d");
    const removed = await restarted.media.removeModel3D(provider, "manual-version", current.editor!.revision);
    const reset = await restarted.media.removeModel3D(provider, "mesh", removed.editor!.revision, true);
    expect(reset.models).toHaveLength(1);
    expect(reset.models[0]).toMatchObject({ name: "Mesh", definition: { polycount: { default: 10000 } } });
  });

  it("uses one current definition for generation after the caller loaded an older catalog", async () => {
    const definition = structuredClone(MODEL3D_MEDIA); definition["3d"]!.editableModels = true;
    definition["3d"]!.models[0]!.modelSettings = { imageOperation: "multi-image-to-3d", modelType: "standard" };
    const { media, requests } = await setup(MODEL3D_TASK, { media: definition, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined });
    const provider = "plugin.acme.flow.flow", initial = await media.listModels(provider, "3d");
    const old = { id: "custom", operations: ["text", "image"] as Array<"text" | "image">, polycount: { min: 100, max: 50000, default: 10000 } };
    const added = await media.saveModel3D(provider, { revision: initial.editor!.revision, templateId: "mesh", model: old });
    const stale = (await media.model3DProviders())[0]!.models.find(model => model.id === "custom")!;
    const updated = { ...old, maxReferenceImages: 1, polycount: { min: 100, max: 5000, default: 2000 }, defaults: { texture: false, pbr: false },
      modelSettings: { imageOperation: "image-to-3d" as const, modelType: "smart-topology" as const } };
    const saved = await media.saveModel3D(provider, { revision: added.editor!.revision, model: updated });
    const input = { model: { provider, id: "custom" }, operation: "text" as const, prompt: "a chair", images: [] };
    await expect(media.generate3D(stale, { ...input, targetPolycount: 40000 })).rejects.toThrow("between 100 and 5000");
    await expect(media.generate3D(stale, { ...input, operation: "image", images: [1, 2].map(() => ({ mediaType: "image/png" as const, data: PNG.toString("base64") })) })).rejects.toThrow("1 to 1 pictures");
    expect(requests).toEqual([]);
    await media.generate3D(stale, input);
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ targetPolycount: 2000, texture: false,
      modelSettings: { imageOperation: "image-to-3d", modelType: "smart-topology" } });
    await media.saveModel3D(provider, { revision: saved.editor!.revision, model: { ...updated, operations: ["image"] } });
    const count = requests.length;
    await expect(media.generate3D(stale, input)).rejects.toThrow("does not support this operation");
    expect(requests).toHaveLength(count);
  });

  it("rejects concurrent stale edits and package changes without losing definitions, hidden choices or adapter data", async () => {
    const provider = "plugin.acme.flow.flow", choices = new PluginMediaModelChoices(root);
    const definition = structuredClone(MODEL3D_MEDIA); definition["3d"]!.editableModels = true;
    definition["3d"]!.models[0]!.data = { contract: 1 };
    const { media } = await setup(MODEL3D_TASK, { media: definition, choices });
    const list = await media.listModels(provider, "3d");
    const model = { id: "manual", operations: ["image"] as const, polycount: { min: 48, max: 50000, default: 48 } };
    const edit = { revision: list.editor!.revision, templateId: "mesh", model: { ...model, operations: [...model.operations] } };
    const results = await Promise.allSettled([media.saveModel3D(provider, edit), media.saveModel3D(provider, { ...edit, model: { ...edit.model, id: "second" } })]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.statusCode).toBe(409);
    const hidden = await media.setModelsShown(provider, "3d", ["manual"], false);
    const snapshot = await readFile(path.join(root, "plugin-media-models.json"), "utf8");
    const revised = structuredClone(definition);
    revised["3d"]!.models.push({ ...revised["3d"]!.models[0]!, id: "manual", data: { contract: 2 } });
    const changed = await setup(MODEL3D_TASK, { digest: "new-package", media: revised, choices });
    const current = await changed.media.listModels(provider, "3d");
    expect(current.models.find(value => value.id === "manual")).toMatchObject({ custom: true, shown: false, definition: { data: { contract: 1 }, polycount: { default: 48 } } });
    await expect(changed.media.removeModel3D(provider, "manual", hidden.editor!.revision)).rejects.toMatchObject({ statusCode: 409 });
    await expect(changed.media.removeModel3D(provider, "manual", current.editor!.revision, true)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(path.join(root, "plugin-media-models.json"), "utf8")).toBe(snapshot);
    const removed = await changed.media.removeModel3D(provider, "manual", current.editor!.revision);
    // A new manifest preset with the same ID must not become enabled by deleting the old custom definition.
    expect(removed.models.find(value => value.id === "manual")).toMatchObject({ custom: false, shown: false, definition: { data: { contract: 2 } } });
    const cloned = await changed.media.saveModel3D(provider, { revision: removed.editor!.revision, templateId: "manual", model: { ...edit.model, id: "new-version" } });
    expect(cloned.models.find(value => value.id === "new-version")!.definition!.data).toEqual({ contract: 2 });
    expect(changed.requests).toEqual([]);
  });

  it("refuses saved definitions when editing support disappears or a processing ID collides", async () => {
    const provider = "plugin.acme.flow.flow", choices = new PluginMediaModelChoices(root);
    const model = MODEL3D_MEDIA["3d"]!.models[0]!;
    await choices.update(provider, "3d", () => ({ added: [], hidden: ["unavailable"], definitions: [{ custom: true, model: { ...model, id: "connection" } }] }));
    const before = await readFile(path.join(root, "plugin-media-models.json"), "utf8");
    const optedOut = await setup(MODEL3D_TASK, { choices, media: MODEL3D_MEDIA });
    await expect(optedOut.media.model3DProviders()).rejects.toMatchObject({ statusCode: 409 });
    const collision = await setup(MODEL3D_TASK, { choices, media: { "3d": { ...MODEL3D_MEDIA["3d"]!, editableModels: true, inputFiles: true,
      processing: { id: "connection", operations: ["remesh"], polycount: model.polycount } } } });
    await expect(collision.media.listModels(provider, "3d")).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(path.join(root, "plugin-media-models.json"), "utf8")).toBe(before);
    expect(collision.requests).toEqual([]);
  });

  it("refuses a changed adapter before submitting a new paid stage", async () => {
    const adapter = `export default { "3d": {
      async start(input, host) {
        const preview = await (await host.submit("preview", "https://api.flow.example/preview", { method: "POST", auth: true, json: {} })).json();
        return { task: { preview: preview.id }, retryAfter: 1 };
      },
      async check(task, host) {
        await host.fetch("https://api.flow.example/status/" + task.preview);
        await host.submit("refine", "https://api.flow.example/refine", { method: "POST", auth: true, json: { preview: task.preview } });
        return { outputs: [{ url: "https://cdn.flow.example/result.glb" }] };
      },
    } };`;
    const first = await setup(adapter, { media: MODEL3D_MEDIA, reply: url => { if (url.includes("/status/")) throw new TypeError("offline"); return undefined; } });
    const model = (await first.media.model3DProviders())[0]!.models[0]!;
    const input = { model, operation: "text" as const, prompt: "chair", images: [] };
    await expect(first.media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow();
    const updated = await setup(adapter, { digest: "d2", media: MODEL3D_MEDIA, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined });
    await expect(updated.media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow("adapter changed");
    expect(updated.requests.filter(request => request.method === "POST")).toEqual([]);
  });

  it.each([undefined, null, 1, "", "../paid"])("refuses invalid paid-step IDs before sending: %s", async (id) => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      return host.submit(${id === undefined ? "undefined" : JSON.stringify(id)}, "https://api.flow.example/paid", { method: "POST" });
    } } };`, { media: MODEL3D_MEDIA });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    await expect(media.generate3D(model, { model, operation: "text", prompt: "chair", images: [] }, undefined, await journalAt())).rejects.toThrow(/submission id/);
    expect(requests).toEqual([]);
  });

  it("refuses a durable submission without a recovery owner", async () => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      return host.submit("preview", "https://api.flow.example/paid", { method: "POST" });
    } } };`, { media: MODEL3D_MEDIA });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    await expect(media.generate3D(model, { model, operation: "text", prompt: "chair", images: [] })).rejects.toThrow("recoverable generation");
    expect(requests).toEqual([]);
  });

  it("reuses a paid refinement response after a failed check and a new host instance", async () => {
    const adapter = `export default { "3d": {
      async start(input, host) {
        const preview = await (await host.submit("preview", "https://api.flow.example/preview", { method: "POST", auth: true, json: { prompt: input.prompt } })).json();
        return { task: { preview: preview.id }, retryAfter: 1 };
      },
      async check(task, host) {
        const refined = await (await host.submit("refine", "https://api.flow.example/refine", { method: "POST", auth: true, json: { preview: task.preview } })).json();
        await host.fetch("https://api.flow.example/status/" + refined.id, { auth: true });
        return { outputs: [{ url: "https://cdn.flow.example/result.glb" }] };
      },
    } };`;
    let offline = true;
    const reply: Reply = url => {
      if (url.includes("/status/") && offline) throw new TypeError("offline after paid response");
      if (url.endsWith(".glb")) return new Response(new Uint8Array(GLB));
      if (url.endsWith("/preview") || url.endsWith("/refine")) return Response.json({ id: "t1", echo: "sk-test" });
      return undefined;
    };
    const first = await setup(adapter, { media: MODEL3D_MEDIA, reply });
    const model = (await first.media.model3DProviders())[0]!.models[0]!;
    const input = { model: { provider: model.provider, id: model.id }, operation: "text" as const, prompt: "Garden chair", images: [] };
    await expect(first.media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow("could not be reached");
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(2);
    offline = false;
    const restored = await setup(adapter, { media: MODEL3D_MEDIA, reply });
    expect((await restored.media.generate3D(model, input, undefined, await journalAt())).bytes).toEqual(GLB);
    expect(restored.requests.filter(request => request.method === "POST")).toEqual([]);
    const file = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(file).not.toContain("sk-test");
  });

  it("retains earlier paid steps after a later definite rejection", async () => {
    const adapter = `export default { "3d": {
      async start(input, host) {
        await host.submit("preview", "https://api.flow.example/preview", { method: "POST", auth: true, json: {} });
        return { task: { id: "preview" }, retryAfter: 1 };
      },
      async check(task, host) {
        const response = await host.submit("refine", "https://api.flow.example/refine", { method: "POST", auth: true, json: {} });
        return { error: "Refinement was rejected" };
      },
    } };`;
    const { media, requests } = await setup(adapter, { media: MODEL3D_MEDIA, reply: url => url.endsWith("/refine") ? Response.json({ error: "bad input" }, { status: 400 }) : undefined });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    const input = { model: { provider: model.provider, id: model.id }, operation: "text" as const, prompt: "chair", images: [] };
    for (let i = 0; i < 2; i++) await expect(media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow("Refinement was rejected");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(2);
  });

  it("does not replay a paid refinement after its response is lost", async () => {
    const { media, requests } = await setup(`export default { "3d": {
      async start(input, host) {
        const preview = await (await host.submit("preview", "https://api.flow.example/preview", { method: "POST", auth: true, json: { prompt: input.prompt } })).json();
        return { task: { preview: preview.id }, retryAfter: 1 };
      },
      async check(task, host) {
        const refined = await (await host.submit("refine", "https://api.flow.example/refine", { method: "POST", auth: true, json: { preview: task.preview } })).json();
        return { task: { refined: refined.id }, retryAfter: 1 };
      },
    } };`, { media: MODEL3D_MEDIA, reply: (url) => {
      if (url.endsWith("/refine")) throw new TypeError("Vendor accepted payment; response was lost");
      return undefined;
    } });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    const input = { model: { provider: model.provider, id: model.id }, operation: "text" as const, prompt: "A garden chair", images: [] };
    await expect(media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow();
    expect(requests.filter(request => request.url.endsWith("/preview"))).toHaveLength(1);
    expect(requests.filter(request => request.url.endsWith("/refine"))).toHaveLength(1);
    await expect(media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow("response was lost");
    expect(requests.filter(request => request.url.endsWith("/refine"))).toHaveLength(1);
  });

  it("lists a provider's 3D models and makes one from a prompt or pictures through a task", async () => {
    const { media, requests } = await setup(MODEL3D_TASK, { media: MODEL3D_MEDIA, reply: (url) => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    expect(model).toEqual({ provider: "plugin.acme.flow.flow", providerName: "Flow", id: "mesh", name: "Mesh", operations: ["text", "image"], maxReferenceImages: 2,
      polycount: { min: 1000, max: 50000, default: 10000, presets: [10000] }, supportsTexture: true, supportsPbr: false, defaults: { texture: true, pbr: false } });
    const ref = { provider: model.provider, id: model.id };
    const made = await media.generate3D(model, { model: ref, operation: "text", prompt: " a chair ", images: [] }, undefined, await journalAt());
    expect(made).toEqual({ bytes: GLB, mediaType: "model/gltf-binary" });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ model: "mesh", operation: "text", prompt: "a chair", references: 0, targetPolycount: 10000, texture: true, pbr: false });
    await (await journalAt()).clear();
    const picture = { mediaType: "image/png" as const, data: PNG.toString("base64") };
    await media.generate3D(model, { model: ref, operation: "image", images: [picture], targetPolycount: 2000, texture: false, pbr: true });
    expect(JSON.parse(requests.at(-2)!.body!)).toEqual({ model: "mesh", operation: "image", references: 1, targetPolycount: 2000, texture: false, pbr: false });
    await expect(media.generate3D(model, { model: ref, operation: "image", images: [picture, picture, picture] })).rejects.toThrow("takes 1 to 2 pictures");
    await expect(media.generate3D(model, { model: ref, operation: "text", prompt: "x", images: [], targetPolycount: 10 })).rejects.toThrow("between 1000 and 50000");
    await expect(media.generate3D(model, { model: ref, operation: "remesh", images: [] })).rejects.toThrow("does not support this operation");
  }, 15_000);

  it("passes a low-poly plugin model's default to its adapter and rejects out-of-range requests", async () => {
    const definition = structuredClone(MODEL3D_MEDIA);
    definition["3d"]!.models[0]!.polycount = { min: 48, max: 50, default: 48, presets: [48, 50] };
    const { media, requests } = await setup(MODEL3D_TASK, { media: definition, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    const input = { model: { provider: model.provider, id: model.id }, operation: "text" as const, prompt: "a low-poly rock", images: [] };
    expect((await media.generate3D(model, input)).bytes).toEqual(GLB);
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ targetPolycount: 48 });
    const count = requests.length;
    for (const targetPolycount of [47, 48.5, 51]) {
      await expect(media.generate3D(model, { ...input, targetPolycount })).rejects.toThrow("between 48 and 50");
    }
    expect(requests).toHaveLength(count);
  });

  it("refuses a file that isn't a GLB model", async () => {
    const { media } = await setup(MODEL3D_TASK, { media: MODEL3D_MEDIA, reply: (url) => url.endsWith(".glb") ? new Response(new Uint8Array(PNG)) : undefined });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    await expect(media.generate3D(model, { model: { provider: model.provider, id: model.id }, operation: "text", prompt: "a chair", images: [] })).rejects.toThrow("isn't a GLB model");
  }, 15_000);

  it("joins the 3D catalog and takes requests for its models", async () => {
    const { media } = await setup(MODEL3D_TASK, { media: MODEL3D_MEDIA, reply: (url) => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined });
    const models3D = new ProviderModels3D({
      runtime: async () => { throw new Error("no runtime"); },
      meshy: { generator: undefined as never, configured: () => false },
      customProviders: async () => [], nativeModels: () => [], isEnabled: () => true, isVisible: () => true, defaultModel: () => undefined,
      plugins: media,
    });
    const catalog = await models3D.catalog();
    expect(catalog.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["plugin.acme.flow.flow/mesh"]);
    expect(catalog.providers).toEqual([{ provider: "plugin.acme.flow.flow", providerName: "Flow", state: "ready" }]);
    const made = await models3D.generate({ model: { provider: "plugin.acme.flow.flow", id: "mesh" }, operation: "text", prompt: "a chair", images: [] });
    expect(made.mediaType).toBe("model/gltf-binary");
    await expect(models3D.generate({ model: { provider: "plugin.acme.flow.flow", id: "nope" }, operation: "text", prompt: "a chair", images: [] })).rejects.toThrow("unavailable");
  }, 15_000);
});

describe("plugin media providers: listing the vendor's models", () => {
  const LISTING = `export default { image: {
    async models(host) {
      const answer = await (await host.fetch("https://api.flow.example/v1/models", { auth: true })).json();
      return { models: [
        { id: "flux", title: "FLUX", description: "Fast pictures", resolutions: ["1K"], aspectRatios: ["1:1", "16:9"], data: { size: "image_size" } },
        { id: "broken", title: "Broken" },
        { id: "kolors", title: "Kolors again", resolutions: ["1K"], aspectRatios: ["1:1"] },
      ], seen: answer.id };
    },
    async start(input, host) {
      await host.fetch("https://api.flow.example/v1/images", { method: "POST", auth: true, json: { model: input.model, data: input.modelData ?? null } });
      return { outputs: [{ url: "https://cdn.flow.example/one.png" }] };
    },
  } };`;
  const discovering = { image: { discoverModels: true, models: [{ id: "kolors", title: "Kolors", resolutions: ["1K"], aspectRatios: ["1:1"] }] } } as Partial<Media>;
  const ids = async (media: PluginMediaProviders) => (await media.imageProviders())[0]!.models.map((model) => model.id);

  it("lists the vendor's models through the adapter, which stay off until turned on", async () => {
    const choices = new PluginMediaModelChoices(root);
    const { media, requests } = await setup(LISTING, { media: discovering, choices });
    const provider = "plugin.acme.flow.flow";
    expect(await media.listModels(provider, "image")).toEqual({ kind: "image", discoverable: true, models: [{ id: "kolors", name: "Kolors", default: true, shown: true }] });
    const listed = await media.listModels(provider, "image", true);
    expect(requests[0]).toMatchObject({ url: "https://api.flow.example/v1/models", headers: { authorization: "Bearer sk-test" } });
    expect(listed).toEqual({ kind: "image", discoverable: true, listedAt: expect.any(String), skipped: 1, models: [
      { id: "kolors", name: "Kolors", default: true, shown: true },
      { id: "flux", name: "FLUX", description: "Fast pictures", default: false, shown: false },
    ] });
    expect(await ids(media)).toEqual(["kolors"]);

    await media.setModelsShown(provider, "image", ["flux"], true);
    await media.setModelsShown(provider, "image", ["kolors"], false);
    expect(await ids(media)).toEqual(["flux"]);
    const flux = (await media.imageProviders())[0]!.models[0]!;
    expect(flux.generationOptions).toEqual([{ resolution: "1K", aspectRatio: "1:1" }, { resolution: "1K", aspectRatio: "16:9" }]);
    await media.generateImage(flux, { prompt: "a fox" });
    // The model's data goes back to the adapter.
    expect(JSON.parse(requests.find((request) => request.url.endsWith("/v1/images"))!.body!)).toEqual({ model: "flux", data: { size: "image_size" } });

    // What's on is kept whole, so a restarted app has it without listing again.
    const again = (await setup(LISTING, { media: discovering, choices: new PluginMediaModelChoices(root) })).media;
    expect(await ids(again)).toEqual(["flux"]);
    expect((await again.listModels(provider, "image")).models.map((model) => [model.id, model.shown])).toEqual([["kolors", false], ["flux", true]]);
    // One not listed in this session can't be turned on.
    await expect(again.setModelsShown(provider, "image", ["other"], true)).rejects.toMatchObject({ statusCode: 409 });
    await again.setModelsShown(provider, "image", ["flux"], false);
    await again.setModelsShown(provider, "image", ["kolors"], true);
    expect(await ids(again)).toEqual(["kolors"]);
  }, 15_000);

  it("turns the manifest's models on and off, but lists nothing more, for a kind that doesn't discover", async () => {
    const { media, requests } = await setup(LISTING);
    const provider = "plugin.acme.flow.flow";
    expect(await media.listModels(provider, "image", true)).toEqual({ kind: "image", discoverable: false, models: [expect.objectContaining({ id: "kolors", shown: true })] });
    expect(requests).toEqual([]);
    await media.setModelsShown(provider, "image", ["kolors"], false);
    expect(await ids(media)).toEqual([]);
    await expect(media.listModels(provider, "video")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("says why the adapter couldn't list its models", async () => {
    const { media } = await setup(`export default { image: { async models() { return { error: "no access" }; }, async start() { return { error: "x" }; } } };`, { media: discovering });
    await expect(media.listModels("plugin.acme.flow.flow", "image", true)).rejects.toThrow("Flow couldn't list its models: no access");
  });

  it("preserves store extensions and absent model preferences across updates and restart", async () => {
    const provider = "plugin.acme.flow.flow", file = path.join(root, "plugin-media-models.json");
    const stored = { version: 2, future: { enabled: true }, providers: {
      [provider]: { futureKind: { models: ["future"] }, image: { added: [], hidden: ["temporarily-absent"], future: { keep: true }, definitions: { opaque: "not-owned-by-image" } } },
      "plugin.other.future": { futureKind: { opaque: [1, 2] } },
    } };
    await writeFile(file, JSON.stringify({ ...stored, version: 1 }));
    const { media } = await setup(LISTING, { choices: new PluginMediaModelChoices(root) });
    await media.setModelsShown(provider, "image", ["kolors"], false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...stored, providers: { ...stored.providers,
      [provider]: { ...stored.providers[provider], image: { ...stored.providers[provider].image, hidden: ["temporarily-absent", "kolors"] } },
    } });
    const again = await setup(LISTING, { choices: new PluginMediaModelChoices(root) });
    expect(await ids(again.media)).toEqual([]);
    await again.media.setModelsShown(provider, "image", ["kolors"], true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(stored);
  });

  it.each([
    { version: 3, providers: {} },
    { version: 1, providers: { other: { "3d": { added: [], hidden: [], definitions: [] } } } },
    { version: 2, providers: { other: { "3d": { added: [], hidden: [], definitions: [{ custom: true, model: { id: "unreadable" } }] } } } },
    { version: 1, providers: { other: null } },
    { version: 1, providers: { other: { image: { added: [{ id: "unreadable" }], hidden: [] } } } },
    { version: 1, providers: { other: { image: { added: [], hidden: [7] } } } },
  ])("refuses writes when a saved choice cannot be understood: %j", async (stored) => {
    const file = path.join(root, "plugin-media-models.json"), text = JSON.stringify(stored, null, 4);
    await writeFile(file, text);
    const { media } = await setup(LISTING, { choices: new PluginMediaModelChoices(root) });
    await expect(media.setModelsShown("plugin.acme.flow.flow", "image", ["kolors"], false)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("isolates nested snapshots and failed changes while serializing valid updates", async () => {
    const choices = new PluginMediaModelChoices(root), provider = "plugin.acme.flow.flow";
    const model = { id: "flux", title: "FLUX", resolutions: ["1K"], aspectRatios: ["1:1"], data: { nested: { keep: true } } };
    await choices.update(provider, "image", () => ({ added: [model as unknown as PluginMediaModels["image"]], hidden: [] }));
    model.data.nested.keep = false;
    const snapshot = await choices.get(provider, "image");
    snapshot.added[0]!.resolutions.length = 0;
    expect((await choices.get(provider, "image")).added[0]).toMatchObject({ resolutions: ["1K"], data: { nested: { keep: true } } });
    const file = path.join(root, "plugin-media-models.json"), before = await readFile(file, "utf8");
    await expect(choices.update(provider, "image", choice => {
      choice.added[0]!.resolutions.length = 0;
      throw new Error("cancel change");
    })).rejects.toThrow("cancel change");
    await expect(choices.update(provider, "image", choice => {
      choice.added[0]!.resolutions.length = 0;
      return choice;
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await choices.get(provider, "image")).added[0]!.resolutions).toEqual(["1K"]);
    await Promise.all([
      choices.update(provider, "image", choice => ({ ...choice, hidden: [...choice.hidden, "first"] })),
      choices.update(provider, "image", choice => ({ ...choice, hidden: [...choice.hidden, "second"] })),
    ]);
    expect((await new PluginMediaModelChoices(root).get(provider, "image")).hidden).toEqual(["first", "second"]);
  });

  it("never writes over a choices file it can't read", async () => {
    await writeFile(path.join(root, "plugin-media-models.json"), "{ not json");
    const { media } = await setup(LISTING, { media: discovering, choices: new PluginMediaModelChoices(root) });
    await expect(ids(media)).rejects.toMatchObject({ statusCode: 409 });
    await expect(media.setModelsShown("plugin.acme.flow.flow", "image", ["kolors"], false)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("media paid-step ownership", () => {
  it("preserves unknown output layout data and its paid receipt when clearing", async () => {
    const journal = await journalAt("future"); await journal.begin({ request: "one" });
    try {
      await journal.submit("audio", "fixture", {}, async save => ({ file: await save(WAV) }));
      const extra = path.join(root, "media-tasks/future.files/future-index.json");
      await writeFile(extra, '{"version":9}');
      const receipt = await readFile(path.join(root, "media-tasks/future.json"), "utf8");
      await expect(journal.clear()).rejects.toThrow("Unsupported task output layout");
      expect(await readFile(extra, "utf8")).toBe('{"version":9}');
      expect(await readFile(path.join(root, "media-tasks/future.json"), "utf8")).toBe(receipt);
      await rm(extra); await journal.clear();
    } finally { journal.release(); }
  });

  it("rejects linked task output directories and files without touching their targets", async () => {
    const journal = await journalAt("linked"); await journal.begin({ request: "one" });
    const outside = path.join(root, "outside"); await mkdir(outside);
    const directory = path.join(root, "media-tasks/linked.files");
    await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(journal.submit("binary", "fixture", {}, async save => save(WAV))).rejects.toThrow("Invalid task files directory");
      await expect(journal.clear()).rejects.toThrow("Invalid task files directory");
      expect(await readdir(outside)).toEqual([]);
      await rm(directory);
      const token = await journal.submit("second", "fixture", {}, async save => save(WAV));
      const target = path.join(outside, "audio.wav");
      await link(path.join(directory, token), target);
      await expect(journal.readOutput(token)).rejects.toThrow("Invalid task output file");
      await journal.clear();
      expect(await readFile(target)).toEqual(WAV);
    } finally { journal.release(); }
  });

  it("bounds total task output storage and closes a completed step's file writer", async () => {
    const journal = await journalAt("bounded"); await journal.begin({ request: "one" });
    let late!: (bytes: Uint8Array) => Promise<string>;
    try {
      await journal.submit("first", "fixture", {}, async save => { late = save; return { file: await save(WAV) }; });
      expect(() => late(WAV)).toThrow("Only an active paid step");
      await expect(journal.submit("empty", "fixture", {}, async save => save(Buffer.alloc(0)))).rejects.toThrow("between 1 byte and 64 MB");
      await expect(journal.submit("large", "fixture", {}, async save => save(Buffer.alloc(64 * 1024 * 1024)))).rejects.toThrow("outputs exceed 64 MB");
      expect(await readdir(path.join(root, "media-tasks/bounded.files"))).toHaveLength(1);
    } finally { journal.release(); }
  });

  it("scopes output references to the generation and refuses traversal or changed ownership", async () => {
    const journal = await journalAt("one"); await journal.begin({ request: "one" });
    const token = await journal.submit("binary", "fixture", {}, async save => save(WAV));
    expect(await journal.readOutput(token)).toEqual(WAV);
    await expect(journal.readOutput("../outside")).rejects.toThrow("Invalid task output reference");
    journal.release();
    const other = await journalAt("two"); await other.begin({ request: "two" });
    try { await expect(other.readOutput(token)).rejects.toThrow("Invalid task output reference"); }
    finally { other.release(); }
    const same = await journalAt("three"); await same.begin({ request: "one" });
    try { await expect(same.readOutput(token)).rejects.toThrow(); }
    finally { same.release(); }
    const changed = await journalAt("one");
    expect(await changed.begin({ request: "changed" })).toEqual({ state: "changed" });
    try { await expect(changed.readOutput(token)).rejects.toThrow("Task ownership is required"); }
    finally { changed.release(); }
  });

  it("bounds the number of paid steps before another request can be sent", async () => {
    const journal = await journalAt(); await journal.begin({ fixture: "bound" });
    const create = vi.fn(async () => ({ id: "paid" }));
    try {
      for (let i = 0; i < 128; i++) await journal.submit(`step-${i}`, "fixture-adapter", { i }, create);
      await expect(journal.submit("extra", "fixture-adapter", {}, create)).rejects.toThrow("Too many paid steps");
      expect(create).toHaveBeenCalledTimes(128);
    } finally { journal.release(); }
  });

  it("keeps an oversized reply unconfirmed rather than sending its paid request again", async () => {
    const journal = await journalAt(); await journal.begin({ fixture: "large" });
    const create = vi.fn(async () => "x".repeat(1024 * 1024));
    try {
      await expect(journal.submit("preview", "fixture-adapter", {}, create)).rejects.toThrow("cannot be recorded");
      await expect(journal.submit("preview", "fixture-adapter", {}, create)).rejects.toThrow("response was lost");
      expect(create).toHaveBeenCalledOnce();
    } finally { journal.release(); }
  });

  it.each(["submitted", "accepted", "binary-saved", "binary-accepted"])("recovers after a process is killed at %s before saving the outer task", async (boundary) => {
    const directory = path.join(root, "journal");
    const child = fork(path.resolve("test/fixtures/media-submission-worker.mjs"), [directory, boundary], {
      execPath: "node", execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); });
    const exited = new Promise(resolve => child.once("close", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`No submission checkpoint: ${stderr}`)), 10_000);
        child.once("message", message => { clearTimeout(timeout); if ((message as { checkpoint?: string }).checkpoint === boundary) resolve(); else reject(new Error("Unexpected submission checkpoint")); });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("close", () => { clearTimeout(timeout); reject(new Error(`Worker exited: ${stderr}`)); });
      });
    } finally { child.kill("SIGKILL"); await exited; }
    const journal = await mediaTaskJournal(directory, "interrupted"), create = vi.fn(async (): Promise<unknown> => ({ id: "duplicate" }));
    try {
      expect(await journal.begin({ provider: "fixture", request: "chair" })).toEqual({ state: "new" });
      if (boundary === "submitted" || boundary === "binary-saved") await expect(journal.submit("preview", "fixture-adapter", { prompt: "chair" }, create)).rejects.toThrow("response was lost");
      else if (boundary === "binary-accepted") {
        const receipt = await journal.submit("preview", "fixture-adapter", { prompt: "chair" }, create) as { file: string };
        expect((await journal.readOutput(receipt.file)).equals(Buffer.alloc(2 * 1024 * 1024, 0xa5))).toBe(true);
      } else expect(await journal.submit("preview", "fixture-adapter", { prompt: "chair" }, create)).toEqual({ id: "paid-preview" });
      expect(create).not.toHaveBeenCalled();
    } finally { journal.release(); }
  });

  it("serializes concurrent steps, reuses their replies, and refuses changed inputs", async () => {
    const journal = await journalAt(); await journal.begin({ fixture: "account" });
    const create = vi.fn(async () => ({ id: "paid" }));
    try {
      expect(await Promise.all([journal.submit("constructor", "fixture-adapter", { a: 1 }, create), journal.submit("constructor", "fixture-adapter", { a: 1 }, create)])).toEqual([{ id: "paid" }, { id: "paid" }]);
      expect(create).toHaveBeenCalledOnce();
      await journal.save({ id: "outer" });
      await expect(journal.submit("constructor", "fixture-adapter", { a: 2 }, create)).rejects.toThrow("changed");
      expect(create).toHaveBeenCalledOnce();
    } finally { journal.release(); }
    const restored = await journalAt();
    try {
      expect(await restored.begin({ fixture: "account" })).toEqual({ state: "resume", task: { id: "outer" } });
      expect(await restored.submit("constructor", "fixture-adapter", { a: 1 }, create)).toEqual({ id: "paid" });
      expect(create).toHaveBeenCalledOnce();
    } finally { restored.release(); }
  });

  it("holds the lease after a waiter releases until the submission owner finishes", async () => {
    const journal = await journalAt(); await journal.begin({ fixture: "account" });
    let finish!: (value: { id: string }) => void;
    const create = vi.fn(() => new Promise<{ id: string }>(resolve => { finish = resolve; }));
    const pending = journal.submit("preview", "fixture-adapter", {}, create);
    await expect.poll(() => create.mock.calls.length).toBe(1);
    journal.release();
    const other = await journalAt();
    await expect(other.begin({ fixture: "account" })).rejects.toThrow("still stopping");
    await expect(other.clear()).rejects.toThrow("still stopping");
    await expect(other.submit("preview", "fixture-adapter", {}, create)).rejects.toThrow("ownership");
    other.release();
    const third = await journalAt();
    await expect(third.begin({ fixture: "account" })).rejects.toThrow("still stopping");
    third.release();
    finish({ id: "paid" }); await pending;
    try {
      expect(await other.begin({ fixture: "account" })).toEqual({ state: "new" });
      expect(await other.submit("preview", "fixture-adapter", {}, create)).toEqual({ id: "paid" });
      expect(create).toHaveBeenCalledOnce();
    } finally { other.release(); }
  });

  it("never restarts an ambiguous raw submission mixed with durable steps", async () => {
    const journal = await journalAt(); await journal.begin({ fixture: "raw" });
    await journal.submit("upload", "fixture-adapter", {}, async () => ({ id: "uploaded" }));
    await journal.unsafeStart(); journal.release();
    const restored = await journalAt();
    try { expect(await restored.begin({ fixture: "raw" })).toEqual({ state: "unconfirmed" }); }
    finally { restored.release(); }
  });

  it.each(["legacy", "future", "unknown", "malformed"])("preserves %s receipts or refuses unsupported writes", async (kind) => {
    const journal = await journalAt(); await journal.begin({ fixture: "record" }); journal.release();
    const file = path.join(root, "media-tasks/job-1.json"), value = JSON.parse(await readFile(file, "utf8"));
    if (kind === "legacy") { delete value.version; value.task = { id: "old-vendor-task" }; }
    if (kind === "future") value.version = 99;
    if (kind === "unknown") value.future = { preserve: true };
    const bytes = kind === "malformed" ? "{private-canary-invalid" : JSON.stringify(value); await writeFile(file, bytes);
    const restored = await journalAt();
    try {
      if (kind === "legacy") {
        expect(await restored.begin({ fixture: "record" })).toEqual({ state: "resume", task: value.task });
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...value, version: 1 });
      } else {
        await expect(restored.begin({ fixture: "record" })).rejects.toThrow(expect.not.stringContaining("private-canary"));
        await expect(restored.clear()).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(bytes);
      }
    } finally { restored.release(); }
  });
});

describe("host-owned media input files", () => {
  const mediaWithFiles = { "3d": { ...MODEL3D_MEDIA["3d"]!, inputFiles: true } };
  const reply: Reply = url => url.endsWith(".glb") ? new Response(new Uint8Array(GLB)) : undefined;

  it.each(["multipart", "json"])("sends reference bytes through %s without passing base64 to the adapter", async (format) => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      const image = input.references[0];
      if ("base64" in image || image.byteLength !== ${PNG.length}) throw new Error("Wrong input contract");
      await host.fetch("https://api.flow.example/upload", { method: "POST", auth: true,
        headers: { "content-type": "incorrect-boundary", "content-length": "1" },
        ${format === "json" ? 'json: { image_url: { $mediaFile: image.file }, nested: [{ $mediaFile: image.file, mediaType: "application/octet-stream" }] }' : 'multipart: [{ name: "images", file: image.file }, { name: "images", file: image.file, filename: "side.png" }, { name: "prompt", value: "椅子" }]'}
      });
      return { outputs: [{ url: "https://cdn.flow.example/result.glb" }] };
    } } };`, { media: mediaWithFiles, reply });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    expect((await media.generate3D(model, { model, operation: "image", images: [{ mediaType: "image/png", data: PNG.toString("base64") }] })).bytes).toEqual(GLB);
    const request = requests[0]!;
    expect(request.headers.authorization).toBe("Bearer sk-test");
    if (format === "json") {
      expect(JSON.parse(request.body!)).toEqual({ image_url: `data:image/png;base64,${PNG.toString("base64")}`, nested: [`data:application/octet-stream;base64,${PNG.toString("base64")}`] });
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["content-length"]).toBeUndefined();
    } else {
      expect(request.headers["content-type"]).toBeUndefined();
      expect(request.headers["content-length"]).toBeUndefined();
      const encoded = new Request(request.url, { method: "POST", headers: request.headers, body: request.form! });
      expect(encoded.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const parsed = await encoded.formData();
      expect(parsed.get("prompt")).toBe("椅子");
      const images = parsed.getAll("images") as File[];
      expect(images.map(file => [file.name, file.type, file.size])).toEqual([["reference-0.png", "image/png", PNG.length], ["side.png", "image/png", PNG.length]]);
      expect(Buffer.from(await images[0]!.arrayBuffer())).toEqual(PNG);
    }
    expect(requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it.each([
    'multipart: [{ name: "file", file: "/etc/passwd" }]',
    'json: { image: { $mediaFile: "unavailable" } }',
    'multipart: [{ name: "file", file: input.references[0].file, filename: "../../private" }]',
    'multipart: [{ name: "file", file: input.references[0].file, value: "ambiguous" }]',
    'multipart: [{ name: "prompt", value: 1 }]',
    'multipart: [], json: {}',
  ])("refuses invalid file requests before HTTP: %s", async (body) => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      await host.fetch("https://api.flow.example/upload", { method: "POST", ${body} });
    } } };`, { media: mediaWithFiles, reply });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    await expect(media.generate3D(model, { model, operation: "image", images: [{ mediaType: "image/png", data: PNG.toString("base64") }] })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each(["image/jpeg", "image/png"] as const)("rejects mismatched or oversized image bytes before calling an adapter: %s", async (mediaType) => {
    const { media, requests } = await setup(MODEL3D_TASK, { media: mediaWithFiles, reply });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    const data = mediaType === "image/jpeg" ? PNG.toString("base64") : "a".repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 4);
    await expect(media.generate3D(model, { model, operation: "image", images: [{ mediaType, data }] })).rejects.toThrow(/reference/);
    expect(requests).toEqual([]);
  });

  it("reuses an upload receipt with fresh file handles after restart and refuses changed bytes", async () => {
    const adapter = `export default { "3d": { async start(input, host) {
      const uploaded = await (await host.submit("upload", "https://api.flow.example/upload", { method: "POST", auth: true,
        multipart: [{ name: "file", file: input.references[0].file }] })).json();
      await host.fetch("https://api.flow.example/status/" + uploaded.id);
      return { outputs: [{ url: "https://cdn.flow.example/result.glb" }] };
    } } };`;
    const first = await setup(adapter, { media: mediaWithFiles, reply: url => { if (url.includes("/status/")) throw new TypeError("offline"); return reply(url, undefined); } });
    const model = (await first.media.model3DProviders())[0]!.models[0]!;
    const input = { model, operation: "image" as const, images: [{ mediaType: "image/png" as const, data: PNG.toString("base64") }] };
    await expect(first.media.generate3D(model, input, undefined, await journalAt())).rejects.toThrow("could not be reached");
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(1);
    const restarted = await setup(adapter, { media: mediaWithFiles, reply });
    const changed = Buffer.from(PNG); changed[changed.length - 1] = 1;
    await expect(restarted.media.generate3D(model, { ...input, images: [{ mediaType: "image/png", data: changed.toString("base64") }] }, undefined, await journalAt())).rejects.toThrow("request changed");
    expect(restarted.requests).toEqual([]);
    expect((await restarted.media.generate3D(model, input, undefined, await journalAt())).bytes).toEqual(GLB);
    expect(restarted.requests.filter(request => request.method === "POST")).toEqual([]);
    const receipt = await readFile(path.join(root, "media-tasks/job-1.json"), "utf8");
    expect(receipt).not.toContain(PNG.toString("base64"));
    expect(receipt).not.toContain("sk-test");
  });

  it.each(["network", "read-method", "opt-out"])("preserves upload boundaries: %s", async (boundary) => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      await host.fetch(${JSON.stringify(boundary === "network" ? "https://unapproved.example/upload" : "https://api.flow.example/upload")}, {
        method: ${JSON.stringify(boundary === "read-method" ? "GET" : "POST")},
        multipart: [{ name: "prompt", value: "chair" }]
      });
    } } };`, { media: boundary === "opt-out" ? MODEL3D_MEDIA : mediaWithFiles, reply });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    await expect(media.generate3D(model, { model, operation: "text", prompt: "chair", images: [] })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("keeps the existing base64 contract unless the provider opts in", async () => {
    const { media } = await setup(`export default { "3d": { async start(input) {
      if (input.references[0].base64 !== ${JSON.stringify(PNG.toString("base64"))} || "file" in input.references[0]) throw new Error("Changed old contract");
      return { outputs: [{ url: "https://cdn.flow.example/result.glb" }] };
    } } };`, { media: MODEL3D_MEDIA, reply });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    expect((await media.generate3D(model, { model, operation: "image", images: [{ mediaType: "image/png", data: PNG.toString("base64") }] })).bytes).toEqual(GLB);
  });

  it("keeps a GLB larger than the sandbox heap in the host and uploads its exact snapshot", async () => {
    const files = new MediaInputFiles(), bytes = Buffer.alloc(70 * 1024 * 1024, 7);
    GLB.copy(bytes);
    const reference = files.add(bytes, "model/gltf-binary", "source.glb");
    expect(JSON.stringify(reference).length).toBeLessThan(200);
    bytes.fill(9); // The caller no longer owns the upload snapshot.
    const result = await runMediaAdapter({
      source: `export default { "3d": { async start(input, host) {
        const response = await host.fetch("https://api.flow.example/upload", { method: "POST", multipart: [{ name: "file", file: input.source.file }] });
        return response.json();
      } } };`, file: "fixture.js", kind: "3d", step: "start", args: [{ source: reference }],
      fetch: async request => {
        const form = files.multipart(request.multipart), file = form.get("file") as File;
        expect(file.size).toBe(70 * 1024 * 1024);
        expect(file.type).toBe("model/gltf-binary");
        expect(Buffer.from(await file.slice(0, GLB.length).arrayBuffer())).toEqual(GLB);
        expect(new Uint8Array(await file.slice(-1).arrayBuffer())[0]).toBe(7);
        return { status: 200, headers: {}, body: '{"id":"uploaded"}' };
      },
    });
    expect(result).toEqual({ id: "uploaded" });
  });

  it("binds handles to content and media type and bounds repeated file expansion", () => {
    const files = new MediaInputFiles(), same = new MediaInputFiles();
    const bytes = Buffer.alloc(80 * 1024 * 1024), ref = files.add(bytes, "model/gltf-binary", "model.glb");
    expect(same.add(bytes, "model/gltf-binary", "renamed.glb").file).toBe(ref.file);
    expect(same.add(Buffer.from("changed"), "model/gltf-binary", "model.glb").file).not.toBe(ref.file);
    expect(() => files.json([{ $mediaFile: ref.file }, { $mediaFile: ref.file }])).toThrow("larger than 200 MB");
    expect(() => files.multipart(Array.from({ length: 3 }, () => ({ name: "file", file: ref.file })))).toThrow("larger than 200 MB");
    expect(() => files.multipart([{ name: "text", value: "x".repeat(1024 * 1024 + 1) }])).toThrow("text is too large");
    expect(() => files.multipart(Array.from({ length: 65 }, () => ({ name: "text", value: "x" })))).toThrow("1 to 64");
    expect(() => files.json({ $mediaFile: ref.file, mediaType: "image/png;base64,forged" })).toThrow("file type");
    expect(() => files.add(Buffer.alloc(0), "image/png", "empty.png")).toThrow("between");
    expect(() => files.add(Buffer.alloc(100 * 1024 * 1024 + 1), "model/gltf-binary", "large.glb")).toThrow("between");
  });
});

describe("plugin 3D processing", () => {
  const processing = { id: "connection", title: "Processing", operations: ["remesh", "retexture"], optionProfile: "meshy",
    polycount: { min: 100, max: 300000, default: 30000 }, texture: true, pbr: true } as const;
  const processingMedia = { "3d": { ...MODEL3D_MEDIA["3d"]!, inputFiles: true, processing } } as unknown as Partial<Media>;
  const router = (media: PluginMediaProviders) => new ProviderModels3D({
    runtime: async () => { throw new Error("No native fallback"); }, meshy: { generator: undefined as never, configured: () => false },
    customProviders: async () => [], nativeModels: () => [], isEnabled: () => true, isVisible: () => false, defaultModel: () => undefined, plugins: media,
  });

  it.each(["retexture", "remesh"] as const)("routes %s with a source snapshot, options and output identity", async (operation) => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      const response = await host.submit("process", "https://api.flow.example/process", { method: "POST", auth: true,
        json: { ...input, source: { $mediaFile: input.source.file } } });
      return { outputs: [{ url: "https://cdn.flow.example/result.glb", forwardAxis: "+Z", requestId: "vendor-task" }] };
    } } };`, { media: processingMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(TEST_GLB)) : undefined });
    const service = router(media), model = (await service.operationModels())[0]!;
    const result = await service.generate({ model, operation, source: TEST_GLB, images: [],
      ...(operation === "retexture" ? { prompt: "  Stone  ", options: { textureModel: "meshy-7" }, targetPolycount: 1200000 } : { targetPolycount: 4000 }),
      journal: await journalAt(),
    });
    expect(result).toMatchObject({ bytes: TEST_GLB, metadata: { forwardAxis: "+Z" }, requestId: "vendor-task" });
    const body = JSON.parse(requests[0]!.body!);
    expect(body.source).toBe(`data:model/gltf-binary;base64,${TEST_GLB.toString("base64")}`);
    expect(body.operation).toBe(operation);
    if (operation === "retexture") expect(body).toMatchObject({ prompt: "Stone", options: { textureModel: "meshy-7" } });
    else expect(body.targetPolycount).toBe(4000);
    expect(requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it("enforces declared processing bounds instead of the profile's geometry defaults", async () => {
    const { media, requests } = await setup(MODEL3D_TASK, { media: { "3d": { ...processingMedia["3d"]!, processing: {
      ...processingMedia["3d"]!.processing!, polycount: { min: 100, max: 20000, default: 4000 },
    } } } });
    const service = router(media), model = (await service.operationModels())[0]!;
    expect(model.remeshPolycount).toEqual({ min: 100, max: 20000, default: 4000, presets: [4000] });
    await expect(service.generate({ model, operation: "remesh", source: TEST_GLB, images: [], targetPolycount: 20001 })).rejects.toThrow("between 100 and 20000");
    expect(requests).toEqual([]);
  });

  it.each(["axis", "request"])("refuses invalid output identity: %s", async (field) => {
    const { media } = await setup(`export default { "3d": { async start() {
      return { outputs: [{ url: "https://cdn.flow.example/result.glb", ${field === "axis" ? 'forwardAxis: "-Y"' : 'requestId: 12'} }] };
    } } };`, { media: processingMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(TEST_GLB)) : undefined });
    const service = router(media), model = (await service.operationModels())[0]!;
    await expect(service.generate({ model, operation: "remesh", source: TEST_GLB, images: [] })).rejects.toThrow("invalid");
  });

  it("recovers a processing job through the Library without repeating its paid submission", async () => {
    const adapter = `export default { "3d": { async start(input, host) {
      await host.submit("process", "https://api.flow.example/process", { method: "POST", auth: true, json: { source: { $mediaFile: input.source.file } } });
      return { outputs: [{ url: "https://cdn.flow.example/result.glb", forwardAxis: "+Z" }] };
    } } };`;
    const first = await setup(adapter, { media: processingMedia, reply: url => { if (url.endsWith(".glb")) throw new TypeError("offline"); return undefined; } });
    const library = new AssetLibrary(root); await library.load();
    const source = await library.add("source.glb", TEST_GLB);
    const runner = new ToolRunner(root, { generate: vi.fn() }, router(first.media), undefined, library); await runner.load();
    const job = runner.start("image-to-3d", { operation: "retexture", model: { provider: "plugin.acme.flow.flow", id: "connection" }, sourceAssetId: source.id, images: [], prompt: "Stone", options: { textureModel: "meshy-7" } });
    await expect.poll(() => runner.jobs()[0]?.status).toBe("failed"); await runner.close();
    const restored = await setup(adapter, { media: processingMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(TEST_GLB)) : undefined });
    const restarted = new ToolRunner(root, { generate: vi.fn() }, router(restored.media), undefined, library); await restarted.load();
    try {
      const retry = restarted.retryJob(job.id);
      await expect.poll(() => restarted.jobs().find(job => job.id === retry.id)?.status).toBe("succeeded");
      const result = restarted.jobs().find(job => job.id === retry.id)!;
      expect(library.get(result.run!.files[0]!.assetId!)?.model3d).toMatchObject({ provider: "plugin.acme.flow.flow", operation: "retexture", forwardAxis: "+Z", triangles: 1 });
      expect(first.requests.filter(request => request.method === "POST")).toHaveLength(1);
      expect(restored.requests.filter(request => request.method === "POST")).toEqual([]);
    } finally { await restarted.close(); }
  });

  it("preserves declared controls and defaults without changing provider identity", async () => {
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      await host.fetch("https://api.flow.example/generate", { method: "POST", json: input });
      return { outputs: [{ url: "https://cdn.flow.example/result.glb", forwardAxis: "+X" }] };
    } } };`, { media: { "3d": { models: [{ ...MODEL3D_MEDIA["3d"]!.models[0]!, optionProfile: "tripo", referenceImageLabels: ["Front", "Left"], estimatedCredits: 12,
      pbr: true, defaults: { texture: true, pbr: true } }] } }, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(TEST_GLB)) : undefined });
    const model = (await media.model3DProviders())[0]!.models[0]!;
    expect(model).toMatchObject({ provider: "plugin.acme.flow.flow", protocol: "tripo", referenceImageLabels: ["Front", "Left"], estimatedCredits: 12, defaults: { texture: true, pbr: true } });
    await media.generate3D(model, { model, operation: "text", prompt: "Chair", images: [] });
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({ texture: true, pbr: true });
  });

  it.each(["missing-source", "bad-source", "bad-count", "generation-source", "wrong-model"])("refuses invalid processing before HTTP: %s", async (variant) => {
    const { media, requests } = await setup(MODEL3D_TASK, { media: processingMedia });
    const service = router(media), model = (await service.operationModels())[0]!;
    const generation = (await media.model3DProviders())[0]!.models[0]!;
    await expect(media.generate3D(variant === "generation-source" ? generation : variant === "wrong-model" ? { ...model, id: "missing" } : model, {
      model, operation: variant === "generation-source" ? "text" : "remesh", images: [],
      ...(variant === "generation-source" ? { prompt: "Chair" } : {}),
      ...(variant !== "missing-source" ? { source: variant === "bad-source" ? Buffer.from("invalid") : TEST_GLB } : {}),
      ...(variant === "bad-count" ? { targetPolycount: 300001 } : {}),
    })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("keeps processing available when generation models are hidden and respects the provider switch", async () => {
    const { media } = await setup(MODEL3D_TASK, { choices: new PluginMediaModelChoices(root), media: { "3d": {
      ...MODEL3D_MEDIA["3d"]!, inputFiles: true,
      processing: { id: "connection", title: "Processing", operations: ["remesh", "retexture"], optionProfile: "meshy",
        polycount: { min: 100, max: 300000, default: 30000 }, texture: true, pbr: true },
    } } as Partial<Media> });
    await media.setModelsShown("plugin.acme.flow.flow", "3d", ["mesh"], false);
    expect((await media.model3DProviders())[0]!.models).toEqual([]);
    let enabled = true;
    const models3D = new ProviderModels3D({
      runtime: async () => { throw new Error("no runtime"); }, meshy: { generator: undefined as never, configured: () => false },
      customProviders: async () => [], nativeModels: () => [], isEnabled: () => enabled, isVisible: () => false,
      defaultModel: () => undefined, plugins: media,
    });
    expect((await models3D.catalog()).models).toEqual([]);
    expect(await models3D.operationModels()).toMatchObject([{ provider: "plugin.acme.flow.flow", id: "connection", protocol: "meshy", operations: ["remesh", "retexture"] }]);
    enabled = false;
    expect(await models3D.operationModels()).toEqual([]);
  });

  it("refuses oversized source models before submission", async () => {
    const { media, requests } = await setup(MODEL3D_TASK, { media: processingMedia });
    const service = router(media), model = (await service.operationModels())[0]!;
    const source = Buffer.alloc(100 * 1024 * 1024 + 1); TEST_GLB.copy(source);
    await expect(service.generate({ model, operation: "remesh", source, images: [] })).rejects.toMatchObject({ statusCode: 413 });
    expect(requests).toEqual([]);
  });

  it("reserves the processing ID across discovery and saved generation choices without erasing them", async () => {
    const provider = "plugin.acme.flow.flow", choices = new PluginMediaModelChoices(root);
    const collision = { ...MODEL3D_MEDIA["3d"]!.models[0]!, id: "connection" };
    await choices.update(provider, "3d", () => ({ added: [collision], hidden: [] }));
    const before = await readFile(path.join(root, "plugin-media-models.json"), "utf8");
    const { media } = await setup(`export default { "3d": { async models() { return { models: ${JSON.stringify([collision, { ...collision, id: "other" }])} }; } } };`, {
      choices, media: { "3d": { ...processingMedia["3d"]!, discoverModels: true } },
    });
    expect((await media.model3DProviders())[0]!.models.map(model => model.id)).toEqual(["mesh"]);
    const listed = await media.listModels(provider, "3d", true);
    expect(listed.skipped).toBe(1);
    expect(listed.models.map(model => model.id)).toEqual(["mesh", "other"]);
    await expect(media.setModelsShown(provider, "3d", ["connection"], true)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(path.join(root, "plugin-media-models.json"), "utf8")).toBe(before);
    expect(await router(media).operationModels()).toMatchObject([{ id: "connection", operations: ["remesh", "retexture"] }]);
  });
});

describe("plugin 3D animation", () => {
  const animationMedia = { "3d": { ...MODEL3D_MEDIA["3d"]!, inputFiles: true, processing: {
    id: "connection", operations: ["animate"], optionProfile: "meshy",
    polycount: { min: 100, max: 300000, default: 30000 }, texture: true,
  } } } as unknown as Partial<Media>;
  const router = (media: PluginMediaProviders, enabled = () => true) => new ProviderModels3D({
    runtime: async () => { throw new Error("No native fallback"); }, meshy: { generator: undefined as never, configured: () => false },
    customProviders: async () => [], nativeModels: () => [], isEnabled: enabled, isVisible: () => false, defaultModel: () => undefined, plugins: media,
  });

  const reuseAdapter = `export default { "3d": {
      async reuse(id, input, previous, host) {
        if (previous) {
          const checked = await (await host.fetch("https://api.flow.example/status/" + previous.id, { auth: true })).json();
          if (checked.id !== previous.id) throw new Error("Uncertain rig status");
          return { valid: checked.valid !== false };
        }
        return { value: await (await host.submit("rig", "https://api.flow.example/rig", { method: "POST", auth: true,
          json: { source: { $mediaFile: input.source.file }, height: input.heightMeters } })).json() };
      },
      async start(input, host) {
      const rig = (await host.reuse("rig")).id;
      await host.submit("animation", "https://api.flow.example/animate", { method: "POST", auth: true, json: { rig, actions: input.actionIds } });
      return { outputs: [{ url: "https://cdn.flow.example/" + input.actionIds[0] + ".glb", forwardAxis: "+Z" }] };
    } } };`;

  it("reuses one paid rig across separate animation jobs for the same source and height", async () => {
    const clips = [await model3DFixture({ rigged: true, clips: ["Idle"] }), await model3DFixture({ rigged: true, clips: ["Walk"] })];
    // The host owns the rig across fresh adapter VMs and independent animation jobs.
    const { media, requests } = await setup(reuseAdapter, { media: animationMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(clips[url.endsWith("0.glb") ? 0 : 1]!)) : undefined });
    const library = new AssetLibrary(root); await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const runner = new ToolRunner(root, { generate: vi.fn() }, router(media), undefined, library); await runner.load();
    try {
      const input = { assetId: source.id, model: { provider: "plugin.acme.flow.flow", id: "connection" }, heightMeters: 1.6 };
      const idle = await runner.run("animate-3d", { ...input, actionIds: [0] });
      const walk = await runner.run("animate-3d", { ...input, actionIds: [1] });
      expect(library.get(idle.files[0]!.assetId!)?.model3d?.animations).toEqual(["Idle"]);
      expect(library.get(walk.files[0]!.assetId!)?.model3d?.animations).toEqual(["Walk"]);
      expect(requests.filter(request => request.url.endsWith("/animate"))).toHaveLength(2);
      expect(requests.filter(request => request.url.endsWith("/rig"))).toHaveLength(1);
    } finally { await runner.close(); }
  });

  it("shares a rig across simultaneous VMs when the first animation is cancelled", async () => {
    const clip = await model3DFixture({ rigged: true, clips: ["Idle"] });
    let finish!: () => void, ownerSignal: AbortSignal | undefined;
    const { media, requests } = await setup(reuseAdapter, { media: animationMedia, reply: (url, signal) => {
      if (url.endsWith("/rig")) return new Promise(resolve => { ownerSignal = signal!; finish = () => resolve(Response.json({ id: "t1" })); });
      if (url.endsWith(".glb")) return new Response(new Uint8Array(clip));
      return undefined;
    } });
    const model = (await router(media).operationModels())[0]!, stop = new AbortController();
    const first = media.animate3D(model, { model: TEST_GLB, actionIds: [0], journal: await journalAt("first") }, stop.signal);
    const rejected = expect(first).rejects.toThrow("waiter cancelled");
    try {
      await expect.poll(() => !!finish).toBe(true);
      stop.abort(new Error("waiter cancelled"));
      await rejected;
      expect(ownerSignal?.aborted).toBe(false);
      const second = media.animate3D(model, { model: TEST_GLB, actionIds: [1], journal: await journalAt("second") });
      finish();
      await expect(second).resolves.toMatchObject({ mediaType: "model/gltf-binary" });
      expect(requests.filter(request => request.url.endsWith("/rig"))).toHaveLength(1);
      expect(requests.filter(request => request.url.endsWith("/animate"))).toHaveLength(1);
    } finally { finish?.(); await media.close(); }
  });

  it.each(["account", "package", "height", "source", "axis", "options"])("keeps persisted rigs isolated when %s changes", async change => {
    const clip = await model3DFixture({ rigged: true, clips: ["Idle"] });
    const reply: Reply = url => url.endsWith(".glb") ? new Response(new Uint8Array(clip)) : undefined;
    const first = await setup(reuseAdapter, { media: animationMedia, reply });
    const model = (await router(first.media).operationModels())[0]!;
    await first.media.animate3D(model, { model: TEST_GLB, actionIds: [0], heightMeters: 1.6, journal: await journalAt("first") });
    await first.media.close();
    const second = await setup(reuseAdapter, { media: animationMedia, reply, ...(change === "account" ? { key: "other-key" } : change === "package" ? { digest: "d2" } : {}) });
    try {
      await second.media.animate3D(model, { model: change === "source" ? await model3DFixture({ rigged: true }) : TEST_GLB,
        actionIds: [1], heightMeters: change === "height" ? 1.8 : 1.6, ...(change === "axis" ? { forwardAxis: "+X" as const } : {}),
        ...(change === "options" ? { options: { rigModel: "v3.0-20260909" as const } } : {}), journal: await journalAt("second") });
      expect(first.requests.filter(request => request.url.endsWith("/rig"))).toHaveLength(1);
      expect(second.requests.filter(request => request.url.endsWith("/rig"))).toHaveLength(1);
    } finally { await second.media.close(); }
  });

  it("reuses a rig after restart and retries unknown validation without poisoning the animation job", async () => {
    const clip = await model3DFixture({ rigged: true, clips: ["Idle"] });
    let status = 200;
    const reply: Reply = url => url.includes("/status/") ? Response.json({ id: "t1" }, { status }) : url.endsWith(".glb") ? new Response(new Uint8Array(clip)) : undefined;
    const first = await setup(reuseAdapter, { media: animationMedia, reply });
    const model = (await router(first.media).operationModels())[0]!;
    await first.media.animate3D(model, { model: TEST_GLB, actionIds: [0], journal: await journalAt("first") });
    await first.media.close();
    // A status response with an unknown/missing task ID must never mean expiry.
    const second = await setup(reuseAdapter, { media: animationMedia, reply: url => status === 503 && url.includes("/status/") ? new Response("unavailable", { status }) : reply(url, undefined) });
    try {
      status = 503;
      await expect(second.media.animate3D(model, { model: TEST_GLB, actionIds: [1], journal: await journalAt("second") })).rejects.toThrow();
      status = 200;
      await expect(second.media.animate3D(model, { model: TEST_GLB, actionIds: [1], journal: await journalAt("second") })).resolves.toMatchObject({ mediaType: "model/gltf-binary" });
      expect(second.requests.filter(request => request.url.endsWith("/rig"))).toHaveLength(0);
    } finally { await second.media.close(); }
  });

  it.each(["raw-write", "nested-reuse", "validation-write", "invalid-validation"])("refuses unsafe shared hooks: %s", async variant => {
    const clip = await model3DFixture({ rigged: true, clips: ["Idle"] });
    let adapter = reuseAdapter;
    if (variant === "raw-write") adapter = adapter.replace('host.submit("rig",', 'host.fetch(');
    if (variant === "nested-reuse") adapter = adapter.replace('return { value: await', 'await host.reuse("nested"); return { value: await');
    if (variant === "validation-write") adapter = adapter.replace('return { valid: checked.valid !== false };', 'await host.submit("invalid", "https://api.flow.example/unsafe", { method: "POST" }); return { valid: true };');
    if (variant === "invalid-validation") adapter = adapter.replace('return { valid: checked.valid !== false };', 'return { valid: "unknown" };');
    const { media, requests } = await setup(adapter, { media: animationMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(clip)) : undefined });
    const model = (await router(media).operationModels())[0]!;
    try {
      if (variant.startsWith("validation") || variant === "invalid-validation") await media.animate3D(model, { model: TEST_GLB, actionIds: [0], journal: await journalAt("first") });
      const before = requests.filter(request => request.method === "POST").length;
      await expect(media.animate3D(model, { model: TEST_GLB, actionIds: [1], journal: await journalAt("second") })).rejects.toThrow();
      expect(requests.filter(request => request.method === "POST")).toHaveLength(before);
    } finally { await media.close(); }
  });

  it("lists actions with scoped auth and rig options while generation models are hidden", async () => {
    const { media, requests } = await setup(`export default { "3d": { async actions(input, host) {
      const response = await host.fetch("https://api.flow.example/actions?rig=" + input.options.rigModel, { auth: true });
      return { actions: await response.json() };
    } } };`, { media: animationMedia, reply: () => Response.json([{ id: "walk", name: "Walk", previewUrl: "https://cdn.flow.example/walk.mp4" }]) });
    const service = router(media), model = (await service.operationModels())[0]!;
    expect(await service.animations(undefined, model, { rigModel: "v3.0-20260909" })).toEqual([{ id: "walk", name: "Walk", category: "Other", subCategory: "Other", previewUrl: "https://cdn.flow.example/walk.mp4" }]);
    expect(requests).toMatchObject([{ method: "GET", url: "https://api.flow.example/actions?rig=v3.0-20260909", headers: { authorization: "Bearer sk-test" } }]);
  });

  it.each(["submit", "post"])("blocks %s from the animation picker before HTTP", async method => {
    const { media, requests } = await setup(`export default { "3d": { async actions(input, host) {
      await host.${method === "submit" ? 'submit("rig", ' : 'fetch('}"https://api.flow.example/rig", { method: "POST" });
      return { actions: [] };
    } } };`, { media: animationMedia });
    const service = router(media), model = (await service.operationModels())[0]!;
    await expect(service.animations(undefined, model)).rejects.toThrow("read-only");
    expect(requests).toEqual([]);
  });

  it.each(["duplicate", "bad-id", "bad-preview", "bad-name", "too-many"])("rejects malformed action lists: %s", async variant => {
    const valid = { id: 0, name: "Idle" };
    const actions = variant === "duplicate" ? [valid, valid] : variant === "bad-id" ? [{ ...valid, id: -1 }]
      : variant === "bad-preview" ? [{ ...valid, previewUrl: "https://unapproved.example/preview" }]
      : variant === "bad-name" ? [{ ...valid, name: "" }] : Array.from({ length: 5001 }, (_, id) => ({ ...valid, id }));
    const { media } = await setup(`export default { "3d": { async actions() { return { actions: ${JSON.stringify(actions)} }; } } };`, { media: animationMedia });
    const service = router(media), model = (await service.operationModels())[0]!;
    await expect(service.animations(undefined, model)).rejects.toThrow();
  });

  it("normalizes a +X source in the host and passes animation controls without exposing its bytes to the VM", async () => {
    const resultBytes = await model3DFixture({ rigged: true, clips: ["Walk"] });
    const { media, requests } = await setup(`export default { "3d": { async start(input, host) {
      if (input.source.base64 || input.source.byteLength < 12) throw new Error("Expected host file");
      await host.submit("rig", "https://api.flow.example/rig", { method: "POST", json: { ...input, source: { $mediaFile: input.source.file } } });
      return { outputs: [{ url: "https://cdn.flow.example/result.glb", forwardAxis: "+Z" }] };
    } } };`, { media: { "3d": { ...animationMedia["3d"]!, processing: { ...animationMedia["3d"]!.processing!, animationSourceAxis: "+Z" } } }, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(resultBytes)) : undefined });
    const service = router(media), model = (await service.operationModels())[0]!;
    const result = await service.animate({ model: TEST_GLB, providerModel: model, actionIds: [30], heightMeters: 1.6, forwardAxis: "+X", journal: await journalAt() });
    const body = JSON.parse(requests[0]!.body!);
    expect(body).toMatchObject({ operation: "animate", actionIds: [30], heightMeters: 1.6, forwardAxis: "+Z" });
    const doc = await new NodeIO().readBinary(Buffer.from(body.source.split(",")[1], "base64"));
    expect(doc.getRoot().listNodes().find(node => node.getName() === "Forward axis +Z")?.getRotation()[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(result.metadata?.forwardAxis).toBe("+Z");
  });

  it.each(["bad-record", "too-many", "axis", "unrigged", "no-clips", "few-clips", "oversized"])("refuses incomplete or invalid animation outputs: %s", async variant => {
    const output = { url: "https://cdn.flow.example/result.glb", forwardAxis: "+Z" };
    const outputs = variant === "bad-record" ? [output, null] : variant === "too-many" ? Array.from({ length: 31 }, () => output)
      : variant === "axis" ? [output, { ...output, forwardAxis: "+X" }] : [output];
    const bytes = await model3DFixture({ rigged: variant !== "unrigged", clips: variant === "no-clips" ? [] : ["Walk"] });
    const { media } = await setup(`export default { "3d": { async start() { return { outputs: ${JSON.stringify(outputs)} }; } } };`, {
      media: animationMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(bytes), { headers: variant === "oversized" ? { "content-length": String(101 * 1024 * 1024) } : {} }) : undefined,
    });
    const service = router(media), model = (await service.operationModels())[0]!;
    await expect(service.animate({ model: TEST_GLB, providerModel: model, actionIds: variant === "few-clips" ? [0, 1] : [0] })).rejects.toThrow();
  });

  it.each(["duplicate-actions", "invalid-source", "height", "disabled"])("rejects invalid animation before HTTP: %s", async variant => {
    const { media, requests } = await setup(MODEL3D_TASK, { media: animationMedia });
    let enabled = true;
    const service = router(media, () => enabled), model = (await service.operationModels())[0]!;
    if (variant === "disabled") enabled = false;
    await expect(service.animate({ model: variant === "invalid-source" ? Buffer.from("invalid") : TEST_GLB, providerModel: model,
      actionIds: variant === "duplicate-actions" ? [0, 0] : [0], ...(variant === "height" ? { heightMeters: 0 } : {}) })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("recovers every animation clip through the Library without submitting the rig or batches again", async () => {
    const adapter = `export default { "3d": { async start(input, host) {
      if (input.operation !== "animate") throw new Error("Expected animation");
      await host.submit("rig", "https://api.flow.example/rig", { method: "POST", auth: true,
        json: { model: { $mediaFile: input.source.file }, height: input.heightMeters } });
      for (const id of input.actionIds) await host.submit("animation-" + id, "https://api.flow.example/animate", { method: "POST", auth: true, json: { action: id } });
      return { outputs: input.actionIds.map(id => ({ url: "https://cdn.flow.example/" + id + ".glb", forwardAxis: "+Z" })) };
    } } };`;
    const clips = [await model3DFixture({ rigged: true, clips: ["Idle"] }), await model3DFixture({ rigged: true, clips: ["Walk"] })];
    const first = await setup(adapter, { media: animationMedia, reply: url => { if (url.endsWith(".glb")) throw new TypeError("offline"); return undefined; } });
    const library = new AssetLibrary(root); await library.load();
    const source = await library.add("hero.glb", TEST_GLB);
    const runner = new ToolRunner(root, { generate: vi.fn() }, router(first.media), undefined, library); await runner.load();
    const job = runner.start("animate-3d", { assetId: source.id, model: { provider: "plugin.acme.flow.flow", id: "connection" }, actionIds: [0, 1], heightMeters: 1.6 });
    await expect.poll(() => runner.jobs()[0]?.status).toBe("failed"); await runner.close();
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(3);
    const restored = await setup(adapter, { media: animationMedia, reply: url => url.endsWith(".glb") ? new Response(new Uint8Array(clips[url.endsWith("0.glb") ? 0 : 1]!)) : undefined });
    const restarted = new ToolRunner(root, { generate: vi.fn() }, router(restored.media), undefined, library); await restarted.load();
    try {
      const retry = restarted.retryJob(job.id);
      await expect.poll(() => restarted.jobs().find(job => job.id === retry.id)?.status).toBe("succeeded");
      const result = restarted.jobs().find(job => job.id === retry.id)!;
      expect(library.get(result.run!.files[0]!.assetId!)?.model3d).toMatchObject({ provider: "plugin.acme.flow.flow", operation: "animate", forwardAxis: "+Z", animations: ["Idle", "Walk"] });
      expect(restored.requests.filter(request => request.method === "POST")).toEqual([]);
    } finally { await restarted.close(); }
  });
});

describe("shared reusable media tasks", () => {
  const scope = { plugin: "acme/flow", provider: "flow", account: "digest", package: "v1", source: "sha256", height: 1.6 };
  const manager = () => new MediaTaskReuse(path.join(root, "media-reuse"));
  const create = (submit: () => Promise<unknown>) => async (journal: Awaited<ReturnType<typeof mediaTaskJournal>>) =>
    journal.submit("rig", "v1", { source: "sha256", height: 1.6 }, submit);

  it("treats reordered input fields as the same prerequisite", async () => {
    const shared = manager(), paid = vi.fn(async () => ({ id: "rig-1" }));
    try {
      await shared.use({ ...scope, options: { rig: "v3", height: 1.6 } }, async () => true, create(paid));
      await shared.use({ options: { height: 1.6, rig: "v3" }, ...scope }, async () => true, create(paid));
      expect(paid).toHaveBeenCalledTimes(1);
    } finally { await shared.close(); }
  });

  it("persists a paid prerequisite across jobs and daemon instances, returning independent values", async () => {
    const first = manager(), paid = vi.fn(async () => ({ id: "rig-1" })), validate = vi.fn(async () => true);
    try {
      const value = await first.use(scope, validate, create(paid));
      (value as { id: string }).id = "caller mutation";
      expect(await first.use(scope, validate, create(paid))).toEqual({ id: "rig-1" });
    } finally { await first.close(); }
    const restarted = manager();
    try { expect(await restarted.use(scope, validate, create(paid))).toEqual({ id: "rig-1" }); }
    finally { await restarted.close(); }
    expect(paid).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("keeps an owner alive when one or all waiters cancel and joins concurrent requests", async () => {
    const shared = manager(), cancelled = new AbortController();
    let finish!: (value: unknown) => void;
    const paid = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const first = shared.use(scope, async () => true, create(paid), cancelled.signal);
    const rejected = expect(first).rejects.toThrow("waiter stopped");
    try {
      await expect.poll(() => paid.mock.calls.length).toBe(1);
      cancelled.abort(new Error("waiter stopped"));
      await rejected;
      // There are now no waiters, but a new job must join the existing owner.
      const second = shared.use(scope, async () => true, create(paid));
      finish({ id: "rig-1" });
      expect(await second).toEqual({ id: "rig-1" });
      expect(paid).toHaveBeenCalledTimes(1);
    } finally { finish?.({ id: "rig-1" }); await shared.close(); }
  });

  it("does not recreate a task after an uncertain paid response, including after restart", async () => {
    const shared = manager(), paid = vi.fn(async () => { throw new Error("response lost"); });
    await expect(shared.use(scope, async () => true, create(paid))).rejects.toThrow("response lost");
    await shared.close();
    const restarted = manager();
    try {
      await expect(restarted.use(scope, async () => true, create(paid))).rejects.toThrow("may already have been submitted");
      expect(paid).toHaveBeenCalledTimes(1);
    } finally { await restarted.close(); }
  });

  it("retains a confirmed paid response when producing its reusable value fails", async () => {
    const shared = manager(), paid = vi.fn(async () => ({ id: "rig-1" }));
    try {
      await expect(shared.use(scope, async () => true, async journal => {
        await create(paid)(journal);
        throw new Error("adapter interrupted");
      })).rejects.toThrow("adapter interrupted");
      expect(await shared.use(scope, async () => true, create(paid))).toEqual({ id: "rig-1" });
      expect(paid).toHaveBeenCalledTimes(1);
    } finally { await shared.close(); }
  });

  it("preserves the receipt when validation is unavailable and replaces it only on explicit expiry", async () => {
    const shared = manager(), paid = vi.fn(async () => ({ id: `rig-${paid.mock.calls.length}` }));
    try {
      await shared.use(scope, async () => true, create(paid));
      await expect(shared.use(scope, async () => { throw new Error("status unavailable"); }, create(paid))).rejects.toThrow("status unavailable");
      expect(await shared.use(scope, async () => true, create(paid))).toEqual({ id: "rig-1" });
      expect(paid).toHaveBeenCalledTimes(1);
      const expired = vi.fn(async () => false);
      expect(await Promise.all([shared.use(scope, expired, create(paid)), shared.use(scope, expired, create(paid))])).toEqual([{ id: "rig-2" }, { id: "rig-2" }]);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(paid).toHaveBeenCalledTimes(2);
    } finally { await shared.close(); }
  });

  it.each(["plugin", "provider", "account", "package", "source", "height"])("isolates changes to %s", async field => {
    const shared = manager(), paid = vi.fn(async () => ({ id: `rig-${paid.mock.calls.length}` }));
    try {
      const first = await shared.use(scope, async () => true, create(paid));
      const other = await shared.use({ ...scope, [field]: "other" }, async () => true, create(paid));
      expect(first).not.toEqual(other);
      expect(paid).toHaveBeenCalledTimes(2);
    } finally { await shared.close(); }
  });

  it.each(["future", "malformed"])("preserves %s shared records without a replacement submission", async variant => {
    const shared = manager(), paid = vi.fn(async () => ({ id: "rig-1" }));
    await shared.use(scope, async () => true, create(paid));
    await shared.close();
    const directory = path.join(root, "media-reuse");
    const filename = path.join(directory, (await readdir(directory))[0]!);
    const original = JSON.parse(await readFile(filename, "utf8"));
    const text = variant === "future" ? JSON.stringify({ ...original, version: 999 }) : "{broken";
    await writeFile(filename, text);
    const restarted = manager();
    try {
      await expect(restarted.use(scope, async () => false, create(paid))).rejects.toThrow();
      expect(paid).toHaveBeenCalledTimes(1);
      expect(await readFile(filename, "utf8")).toBe(text);
    } finally { await restarted.close(); }
  });

  it("pins a generation's reference even when a later job replaces the shared rig", async () => {
    const shared = manager(), paid = vi.fn(async () => ({ id: `rig-${paid.mock.calls.length}` }));
    const first = await journalAt("first");
    await first.begin({ action: 0 });
    try {
      expect(await first.reference("_reuse-rig", "package", scope, () => shared.use(scope, async () => true, create(paid)))).toEqual({ id: "rig-1" });
      expect(await shared.use(scope, async () => false, create(paid))).toEqual({ id: "rig-2" });
      first.release();
      const restarted = await journalAt("first");
      try {
        expect(await restarted.begin({ action: 0 })).toEqual({ state: "new" });
        const resolve = vi.fn(() => shared.use(scope, async () => true, create(paid)));
        expect(await restarted.reference("_reuse-rig", "package", scope, resolve)).toEqual({ id: "rig-1" });
        expect(resolve).not.toHaveBeenCalled();
        await expect(restarted.submit("_reuse-rig", "package", scope, paid)).rejects.toThrow("Invalid submission id");
      } finally { restarted.release(); }
    } finally { first.release(); await shared.close(); }
  });

  it("holds the owner through a late receipt after its adapter stops", async () => {
    const shared = manager();
    let finish!: (value: unknown) => void, submitted!: () => void;
    const begun = new Promise<void>(resolve => { submitted = resolve; });
    const paid = vi.fn(() => new Promise(resolve => { finish = resolve; submitted(); }));
    const result = shared.use(scope, async () => true, async journal => {
      void create(paid)(journal).catch(() => {});
      await begun;
      throw new Error("VM stopped");
    });
    const rejected = expect(result).rejects.toThrow("VM stopped");
    await begun;
    let closed = false;
    const closing = shared.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    finish({ id: "rig-1" });
    await rejected;
    await closing;
    const restarted = manager();
    try {
      expect(await restarted.use(scope, async () => true, create(paid))).toEqual({ id: "rig-1" });
      expect(paid).toHaveBeenCalledTimes(1);
    } finally { await restarted.close(); }
  });

  it("aborts an owned request on shutdown, waits for cleanup, and preserves its uncertain receipt", async () => {
    const shared = manager();
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    let cleaned = false;
    const result = shared.use(scope, async () => true, async (journal, signal) => journal.submit("rig", "v1", {}, async () => {
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => { cleaned = true; reject(signal.reason); }, { once: true }));
    }));
    const rejected = expect(result).rejects.toBeInstanceOf(GenerationShutdown);
    await begun;
    await shared.close();
    await rejected;
    expect(cleaned).toBe(true);
    await expect(shared.use(scope, async () => true, create(async () => ({})))).rejects.toBeInstanceOf(GenerationShutdown);
    const restarted = manager(), paid = vi.fn(async () => ({ id: "duplicate" }));
    try {
      await expect(restarted.use(scope, async () => true, async journal => journal.submit("rig", "v1", {}, paid))).rejects.toThrow("may already have been submitted");
      expect(paid).not.toHaveBeenCalled();
    } finally { await restarted.close(); }
  });
});

describe("plugin 3D account balance", () => {
  const declared = { "3d": { ...MODEL3D_MEDIA["3d"]!, balance: true } };
  const adapter = `export default { "3d": { async balance(_input, host) {
    return await (await host.fetch("https://api.flow.example/balance", { auth: true })).json();
  } } };`;

  it.each(["undeclared", "missing-key", "permissions"])("refuses %s before network", async variant => {
    const { media, requests } = await setup(adapter, { media: variant === "undeclared" ? MODEL3D_MEDIA : declared,
      ...(variant === "missing-key" ? { key: undefined } : variant === "permissions" ? { allowed: false } : {}) });
    await expect(media.balance3D("plugin.acme.flow.flow")).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each(['host.submit("paid", "https://api.flow.example/paid", { method: "POST" })',
    'host.fetch("https://api.flow.example/paid", { method: "POST" })', 'host.reuse("rig")',
    'host.fetch("https://api.flow.example/paid", { multipart: [] })', 'host.fetch("https://unapproved.example/balance")'])("rejects unsafe balance calls: %s", async call => {
    const { media, requests } = await setup(`export default { "3d": { async balance(_input, host) { await ${call}; return { balance: 0 }; } } };`, { media: declared });
    await expect(media.balance3D("plugin.acme.flow.flow")).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([null, {}, { balance: "12" }, { balance: null }, { balance: 2, frozen: -1 }, { balance: 2, frozen: "1" }, { balance: 2, frozen: null }])("rejects malformed balance %j", async value => {
    const { media } = await setup(adapter, { media: declared, reply: () => Response.json(value) });
    await expect(media.balance3D("plugin.acme.flow.flow")).rejects.toThrow("invalid balance");
  });

  it("keeps finite negative account credits and zero frozen credits", async () => {
    const { media } = await setup(adapter, { media: declared, reply: () => Response.json({ balance: -0.5, frozen: 0, unusedVendorField: "preserved by vendor" }) });
    expect(await media.balance3D("plugin.acme.flow.flow")).toEqual({ balance: -0.5, frozen: 0 });
  });

  it("bounds vendor feedback and redacts the configured key", async () => {
    const { media } = await setup(adapter, { media: declared, reply: () => Response.json({ error: "sk-test " + "x".repeat(2000) }) });
    const error = await media.balance3D("plugin.acme.flow.flow").catch(cause => cause as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("sk-test");
    expect((error as Error).message.length).toBeLessThanOrEqual(1006);
  });

  it("cancels an in-flight balance request without retrying", async () => {
    let observed!: AbortSignal;
    const { media, requests } = await setup(adapter, { media: declared, reply: (_url, signal) => new Promise((_, reject) => {
      observed = signal!; signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }) });
    const controller = new AbortController(), result = media.balance3D("plugin.acme.flow.flow", controller.signal);
    const rejected = expect(result).rejects.toThrow("balance cancelled");
    await expect.poll(() => !!observed).toBe(true);
    controller.abort(new Error("balance cancelled"));
    await rejected;
    expect(observed.aborted).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("bounds a stalled balance query to thirty seconds", async () => {
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const { media, requests } = await setup(adapter, { media: declared, reply: (_url, signal) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); started();
    }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
      return controller.signal;
    });
    const result = media.balance3D("plugin.acme.flow.flow");
    const rejected = expect(result).rejects.toMatchObject({ statusCode: 504 });
    try {
      await requested;
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(requests).toHaveLength(1);
    } finally { timeout.mockRestore(); vi.useRealTimers(); await media.close(); }
  });

  it("reads a declared generation-only provider's balance through the existing service without native dispatch", async () => {
    const { media, requests } = await setup(`export default { "3d": { async balance(_input, host) {
      return await (await host.fetch("https://api.flow.example/balance", { auth: true })).json();
    } } };`, { media: declared,
      reply: () => Response.json({ balance: 123.5, frozen: 4 }) });
    const native = vi.fn(async () => { throw new Error("Unexpected native balance dispatch"); });
    const service = new ProviderModels3D({ runtime: native, meshy: { generator: undefined as never, configured: () => false },
      customProviders: async () => [], nativeModels: () => [], isEnabled: () => true, isVisible: () => false, defaultModel: () => undefined, plugins: media });
    try {
      expect(await service.balance({ provider: "plugin.acme.flow.flow", id: "connection" })).toEqual({ balance: 123.5, frozen: 4 });
      expect(native).not.toHaveBeenCalled();
      expect(requests).toMatchObject([{ method: "GET", url: "https://api.flow.example/balance", headers: { authorization: "Bearer sk-test" } }]);
      expect(requests).toHaveLength(1);
      await expect(service.balance({ provider: "plugin.acme.flow.flow", id: "wrong-model" })).rejects.toMatchObject({ statusCode: 400 });
      expect(requests).toHaveLength(1);
    } finally { await media.close(); }
  });
});


describe("plugin background removal", () => {
  // Two-frame APNG; libvips reports only its default PNG frame.
  const animatedPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAGQD6AAAAVWPHQAAABVJREFUeJxj/M/A0MDAwMDABCJAGAAYJQGDnf1UaAAAABpmY1RMAAAAAQAAAAIAAAACAAAAAAAAAAAAZAPoAACaJmXJAAAAGWZkQVQAAAACeJxjZPjP8J+BgYGBCUSAMAAeGAICRb04jgAAAABJRU5ErkJggg==", "base64");
  const processingMedia = { image: { models: [{ id: "draw", resolutions: ["1K"], aspectRatios: ["1:1"] }], backgroundRemoval: { id: "cutout", title: "Cutout" } } } as unknown as Partial<Media>;
  const model = { provider: "plugin.acme.flow.flow", id: "cutout" };
  const sourcePixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255]);
  const png = (pixels = sourcePixels, width = 2, height = 2) => sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const adapter = `export default { image: { async start(input, host) {
    if (input.operation !== "remove-background" || input.prompt || input.aspectRatio || input.image.base64 || !input.image.file) throw new Error("Wrong cutout contract");
    const reply = await host.fetch("https://api.flow.example/cutout", { method: "POST", auth: true, json: { image: { $mediaFile: input.image.file } } });
    return { outputs: [{ url: (await reply.json()).url }] };
  } } };`;

  it("retries a canvas import failure after restart with the same paid receipt and source snapshot", async () => {
    const source = await png();
    const { media, requests } = await setup(adapter, { media: processingMedia, reply: url => url.startsWith("https://cdn.") ? new Response(new Uint8Array(source)) : undefined });
    const library = new AssetLibrary(root), projects = new ProjectManager(root, library);
    const generator = { generate: vi.fn().mockRejectedValue(new Error("Wrong generation route")), removeBackground: media.removeBackground.bind(media) };
    const tools = new ToolRunner(root, generator, undefined, undefined, library);
    await Promise.all([library.load(), projects.load(), tools.load()]);
    const project = await projects.create("Cutout", "asset-canvas");
    let store = new CanvasStore(projects, library, tools);
    try {
      const boardId = (await store.workspace(project.id)).boards[0]!.id;
      const detail = await store.board(project.id, boardId);
      const input = await library.add("source.png", source);
      const node = createAssetGenerationNode("image", { x: 0, y: 0 });
      if (node.type !== "image") throw new Error("Expected image");
      Object.assign(node.data, { backgroundRemoval: true, prompt: "", model, images: [{ type: "library", assetId: input.id }] });
      detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
      await store.saveBoard(project.id, detail.board, detail.revision);
      const importAsset = vi.spyOn(projects, "materializeLibraryAsset").mockRejectedValueOnce(new Error("Import disk unavailable"));
      const job = await store.generateNode(project.id, boardId, node.id);
      await expect.poll(async () => (await store.jobs(project.id))[0]?.status).toBe("failed");
      expect((await store.jobs(project.id))[0]?.error).toContain("Import disk unavailable");
      expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
      const history = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"));
      expect(history[0].input.image.data).toBe(source.toString("base64"));
      importAsset.mockRestore();
      await store.close();
      store = new CanvasStore(projects, library, tools);
      await store.retry(project.id, job.id);
      await expect.poll(async () => (await store.jobs(project.id))[0]?.status).toBe("succeeded");
      expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
      expect(generator.generate).not.toHaveBeenCalled();
      expect((await store.board(project.id, boardId)).board.nodes.find(candidate => candidate.id === node.id)?.data).toMatchObject({ backgroundRemoval: true, model, assetId: expect.any(String) });
      const receiptId = history[0].recoveryId ?? history[0].id;
      expect(await inspectMediaTaskJournal(path.join(root, "tools/media-tasks"), receiptId)).toBe("result-recorded");
    } finally { await store.close(); }
  });

  it("rejects malformed, oversized, animated and fully transparent inputs before any submission", async () => {
    const { media, requests } = await setup(adapter, { media: processingMedia });
    const animated = await sharp(Buffer.concat([Buffer.alloc(16, 100), Buffer.alloc(16, 200)]), { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    for (const source of [PNG, Buffer.alloc(20 * 1024 * 1024 + 1), animated, animatedPng, await png(Buffer.alloc(16))]) {
      await expect(media.removeBackground(model, source, undefined, await journalAt())).rejects.toThrow();
    }
    expect(requests).toHaveLength(0);
  });

  it("requires grants and a key, and excludes processing from generation visibility", async () => {
    for (const options of [{ allowed: false }, { key: undefined }]) {
      const { media, requests } = await setup(adapter, { media: processingMedia, ...options });
      expect(await media.backgroundRemovalModels()).toEqual([]);
      await expect(media.removeBackground(model, await png(), undefined, await journalAt())).rejects.toThrow("available");
      expect(requests).toHaveLength(0);
    }
    const { media } = await setup(adapter, { media: processingMedia });
    await expect(media.setModelsShown(model.provider, "image", ["cutout"], true)).rejects.toThrow();
  });

  it("preserves source colors, dimensions and existing alpha while applying the vendor alpha mask", async () => {
    const mask = await png(Buffer.from([12, 34, 56, 0, 12, 34, 56, 128, 12, 34, 56, 255, 12, 34, 56, 255]));
    const source = await png();
    const { media, requests } = await setup(adapter, { media: processingMedia, reply: url => url.startsWith("https://cdn.") ? new Response(new Uint8Array(mask)) : undefined });
    expect(await media.backgroundRemovalModels()).toEqual([{ ...model, name: "Cutout", providerName: "Flow" }]);
    expect((await media.imageProviders())[0]!.models.map(item => item.id)).toEqual(["draw"]);
    const result = await media.removeBackground(model, source, undefined, await journalAt());
    const decoded = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height, decoded.info.channels]).toEqual([2, 2, 4]);
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 0, 255, 0, 64, 0, 0, 255, 0, 255, 255, 255, 255]);
    expect(JSON.parse(requests[0]!.body!).image).toMatch(/^data:image\/png;base64,/);
    expect(requests.at(-1)!.headers.authorization).toBeUndefined();
  });

  it("keeps a paid cutout after download failure and rejects a changed source before resuming", async () => {
    const source = await png();
    const first = await setup(adapter, { media: processingMedia, reply: url => { if (url.startsWith("https://cdn.")) throw new Error("offline"); return undefined; } });
    await expect(first.media.removeBackground(model, source, undefined, await journalAt())).rejects.toThrow("downloaded");
    const restored = await setup(adapter, { media: processingMedia, reply: url => url.startsWith("https://cdn.") ? new Response(new Uint8Array(source)) : undefined });
    await expect(restored.media.removeBackground(model, await png(Buffer.alloc(16, 80)), undefined, await journalAt())).rejects.toThrow("request changed");
    expect(restored.requests).toHaveLength(0);
    await restored.media.removeBackground(model, source, undefined, await journalAt());
    expect(first.requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(restored.requests.map(request => request.method)).toEqual(["GET"]);
  });

  it.each(["size", "opaque", "empty", "no-alpha", "animated"])("rejects a %s cutout without a replacement paid request", async kind => {
    const source = await png();
    const mask = kind === "animated" ? animatedPng : kind === "size" ? await png(Buffer.from([1, 2, 3, 100]), 1, 1)
      : kind === "no-alpha" ? await sharp(source).removeAlpha().png().toBuffer()
      : await png(Buffer.from(Array.from({ length: 16 }, (_, index) => index % 4 === 3 ? (kind === "opaque" ? 255 : 0) : 100)));
    const { media, requests } = await setup(adapter, { media: processingMedia, reply: url => url.startsWith("https://cdn.") ? new Response(new Uint8Array(mask)) : undefined });
    for (let attempt = 0; attempt < 2; attempt++) await expect(media.removeBackground(model, source, undefined, await journalAt())).rejects.toThrow();
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });
});
