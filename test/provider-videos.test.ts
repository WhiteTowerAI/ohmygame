import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProviderVideos } from "../src/daemon/provider-videos.js";

describe("ProviderVideos", () => {
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
