import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { readBoundedVideo, readDownloadedVideo } from "../src/daemon/video-generation.js";
import { ProviderVideos } from "../src/daemon/provider-videos.js";

describe("ProviderVideos", () => {
  it.each([false, true])("gates built-in MiniMax catalog and submission on committed cutover: %s", async (committed) => {
    const request = vi.fn<typeof fetch>();
    const videos = new ProviderVideos(async () => runtime(false), request, undefined, undefined, { minimaxApiKey: () => "retained-key", minimaxSettingsMigrated: committed });
    const catalog = await videos.catalog();
    expect(catalog.models.some(model => model.provider === "minimax-video-global")).toBe(!committed);
    if (committed) await expect(videos.generate({ prompt: "Do not resubmit", model: { provider: "minimax-video-global", id: "MiniMax-H3" }, duration: 6, resolution: "720p", aspectRatio: "16:9" })).rejects.toMatchObject({ statusCode: 409 });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not fall back to retained keys when the migrated plugin is unavailable", async () => {
    const request = vi.fn<typeof fetch>();
    const videos = new ProviderVideos(async () => runtime(false), request, undefined, undefined, { minimaxApiKey: () => "retained-key", minimaxSettingsMigrated: true });
    await expect(videos.catalog()).resolves.toEqual({ models: [], providers: [] });
    await expect(videos.generate({ prompt: "No fallback", model: { provider: "plugin.ohmygame.minimax.global", id: "MiniMax-H3" }, duration: 6, resolution: "720p", aspectRatio: "16:9" })).rejects.toMatchObject({ statusCode: 503 });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("gates both Seedance regions without fallback after cutover: %s", async (committed) => {
    const request = vi.fn<typeof fetch>();
    const videos = new ProviderVideos(async () => runtime(false), request, () => "retained", undefined, { seedanceSettingsMigrated: committed });
    const catalog = await videos.catalog();
    for (const provider of ["volcengine-ark", "byteplus-modelark"]) {
      expect(catalog.models.some(model => model.provider === provider)).toBe(!committed);
      if (committed) await expect(videos.generate({ prompt: "Do not replay", model: { provider, id: "any-old-model" } })).rejects.toMatchObject({ statusCode: 409 });
    }
    if (committed) {
      expect(catalog).toEqual({ models: [], providers: [] });
      await expect(videos.generate({ prompt: "No fallback", model: { provider: "plugin.ohmygame.seedance.ark", id: "doubao-seedance-2-5-260628" } })).rejects.toMatchObject({ statusCode: 503 });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("creates, polls, and downloads an OpenRouter video", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(Response.json({ id: "video-job", status: "pending", polling_url: "https://openrouter.ai/api/v1/videos/video-job" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", unsigned_urls: ["https://files.example/video.mp4"] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const videos = new ProviderVideos(async () => runtime(), request);

    await expect(videos.generate({
      prompt: "A cinematic game trailer",
      model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" },
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
    })).resolves.toEqual({ bytes: Buffer.from([1, 2, 3]), mediaType: "video/mp4", requestId: "video-job" });

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/videos/models",
      "https://openrouter.ai/api/v1/videos",
      "https://openrouter.ai/api/v1/videos/video-job",
      "https://files.example/video.mp4",
    ]);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      model: "bytedance/seedance-2.0-mini",
      prompt: "A cinematic game trailer",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
    });
  });

  it("lists OpenRouter models only when its credential is configured", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [videoModel()] }));
    const configured = new ProviderVideos(async () => runtime(), request);
    const unavailable = new ProviderVideos(async () => runtime(false), request);

    await expect(configured.models()).resolves.toEqual([expect.objectContaining({ id: "bytedance/seedance-2.0-mini" })]);
    await expect(unavailable.models()).resolves.toEqual([]);
  });

  it("lists configured official providers even when OpenRouter is unavailable", async () => {
    const keys = (providerId: string) => providerId === "volcengine-ark" ? "volc-key" : undefined;
    const videos = new ProviderVideos(async () => { throw new Error("Pi unavailable"); }, vi.fn<typeof fetch>(), keys);

    await expect(videos.catalog()).resolves.toEqual({
      models: expect.arrayContaining([
        expect.objectContaining({ provider: "volcengine-ark", id: "doubao-seedance-2-5-260628", imageReferenceMode: "reference", referenceModes: ["reference", "frame"], frameAspectRatios: ["adaptive"] }),
        expect.objectContaining({ provider: "volcengine-ark", id: "doubao-seedance-2-0-260128" }),
      ]),
      providers: [{ provider: "volcengine-ark", providerName: "Volcengine Ark", state: "ready" }],
    });
  });

  it("dispatches an official model without loading the OpenRouter runtime", async () => {
    const runtimeFactory = vi.fn(async () => runtime());
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "official-job" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "https://files.example/official.mp4" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7]), { status: 200 }));
    const videos = new ProviderVideos(runtimeFactory, request, () => "volc-key");

    await expect(videos.generate({
      prompt: "A clockwork garden",
      model: { provider: "volcengine-ark", id: "doubao-seedance-2-0-260128" },
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
    })).resolves.toMatchObject({ requestId: "official-job", bytes: Buffer.from([7]) });
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("rejects unsafe video URLs, oversized responses, and request timeouts", async () => {
    const unsafeRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(Response.json({ id: "job-1", status: "pending", polling_url: "https://openrouter.ai/api/v1/videos/job-1" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", unsigned_urls: ["http://169.254.169.254/latest"] }));
    const videos = new ProviderVideos(async () => runtime(), unsafeRequest);
    await expect(videos.generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } })).rejects.toMatchObject({ statusCode: 502 });

    const bigRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(Response.json({ id: "job-2", status: "pending", polling_url: "https://openrouter.ai/api/v1/videos/job-2" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", unsigned_urls: ["https://files.example/big.mp4"] }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "content-length": String(201 * 1024 * 1024) } }));
    await expect(new ProviderVideos(async () => runtime(), bigRequest).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } })).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("size limit") });

    const timeoutRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await expect(new ProviderVideos(async () => runtime(), timeoutRequest).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } })).rejects.toMatchObject({ statusCode: 504 });

    const streamTimeoutRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(Response.json({ id: "job-3", status: "pending", polling_url: "https://openrouter.ai/api/v1/videos/job-3" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", unsigned_urls: ["https://files.example/slow.mp4"] }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        pull() {
          return Promise.reject(Object.assign(new Error("body timeout"), { name: "TimeoutError" }));
        },
      }), { status: 200 }));
    await expect(new ProviderVideos(async () => runtime(), streamTimeoutRequest).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } })).rejects.toMatchObject({ statusCode: 504 });

    const cancelOnError = vi.fn(async () => {});
    const failedDownload = new Response(new ReadableStream({
      cancel: cancelOnError,
      pull(controller) { controller.enqueue(new Uint8Array([1])); },
    }), { status: 500 });
    await expect(readDownloadedVideo(async () => failedDownload, "OpenRouter")).rejects.toMatchObject({ statusCode: 500 });
    expect(cancelOnError).toHaveBeenCalledOnce();

    const cancelOnOverflow = vi.fn(async () => {});
    const oversizedStream = new Response(new ReadableStream({
      cancel: cancelOnOverflow,
      pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4, 5])); },
    }), { status: 200 });
    await expect(readBoundedVideo(oversizedStream, "OpenRouter", 4)).rejects.toMatchObject({ statusCode: 502 });
    expect(cancelOnOverflow).toHaveBeenCalledOnce();

    const nonJsonPoll = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(Response.json({ id: "job-4", status: "pending", polling_url: "https://openrouter.ai/api/v1/videos/job-4" }))
      .mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }));
    await expect(new ProviderVideos(async () => runtime(), nonJsonPoll).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } }))
      .rejects.toMatchObject({ statusCode: 502, message: "OpenRouter video status request failed" });
    expect(nonJsonPoll).toHaveBeenCalledTimes(3);

    const nullOk = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(new Response("null", { status: 200 }));
    await expect(new ProviderVideos(async () => runtime(), nullOk).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } }))
      .rejects.toMatchObject({ statusCode: 502, message: "OpenRouter video generation request failed" });

    const nullErr = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockResolvedValueOnce(new Response("null", { status: 500 }));
    await expect(new ProviderVideos(async () => runtime(), nullErr).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } }))
      .rejects.toMatchObject({ statusCode: 502, message: "OpenRouter video generation request failed" });

    const unreachable = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [videoModel()] }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(new ProviderVideos(async () => runtime(), unreachable).generate({ prompt: "x", model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } }))
      .rejects.toMatchObject({ statusCode: 502, message: "Could not reach OpenRouter" });
  });
});

function videoModel() {
  return {
    id: "bytedance/seedance-2.0-mini",
    name: "ByteDance: Seedance 2.0 Mini",
    description: "Text-to-video generation",
    supported_resolutions: ["480p", "720p"],
    supported_aspect_ratios: ["16:9", "9:16"],
    supported_durations: [4, 5, 6],
    supported_frame_images: ["first_frame"],
  };
}

function runtime(configured = true): ModelRuntime {
  return {
    getProvider: (id: string) => id === "openrouter" ? { id, name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" } : undefined,
    hasConfiguredAuth: (id: string) => id === "openrouter" && configured,
    getAuth: async () => configured ? { auth: { apiKey: "sk-or" }, source: "test" } : undefined,
  } as unknown as ModelRuntime;
}
