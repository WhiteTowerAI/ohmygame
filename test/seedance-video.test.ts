import { describe, expect, it, vi } from "vitest";
import { ManagedVideoGenerator, type VideoSource } from "../src/daemon/seedance-video.js";
import { DEFAULT_VIDEO_MODEL, VIDEO_MODELS } from "../src/shared/contracts.js";

describe("managed Seedance video adapter", () => {
  it("creates, polls, and downloads a video through the New API contract", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-1", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ data: { task_id: "task-1", status: "SUCCESS", result_url: "https://files.example/video.mp4" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const generator = new ManagedVideoGenerator(() => source(), request);

    await expect(generator.generate({ prompt: "Animate", model: DEFAULT_VIDEO_MODEL, duration: 6, resolution: "1080p", aspectRatio: "21:9" }))
      .resolves.toMatchObject({ bytes: Buffer.from([1, 2, 3]), mediaType: "video/mp4", requestId: "task-1" });
    expect(request).toHaveBeenNthCalledWith(1, "https://account.example/v1/video/generations", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
    }));
    expect(request).toHaveBeenNthCalledWith(2, "https://account.example/v1/video/generations/task-1", expect.objectContaining({
      headers: { authorization: "Bearer secret" },
    }));
    expect(request).toHaveBeenNthCalledWith(3, "https://files.example/video.mp4", { signal: undefined });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: DEFAULT_VIDEO_MODEL,
      prompt: "Animate",
      seconds: "6",
      metadata: { resolution: "1080p", ratio: "21:9" },
    });
  });

  it("sends every media reference through one Seedance content array and removes staged files", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-2", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ data: { task_id: "task-2", status: "FAILURE", fail_reason: "blocked" } }));
    const stageMedia = vi.fn()
      .mockResolvedValueOnce({ id: "image-id", url: "https://media.example/image.png" })
      .mockResolvedValueOnce({ id: "video-id", url: "https://media.example/video.mp4" })
      .mockResolvedValueOnce({ id: "audio-id", url: "https://media.example/audio.mp3" });
    const removeMedia = vi.fn().mockResolvedValue(undefined);
    const generator = new ManagedVideoGenerator(() => source({ stageMedia, removeMedia }), request);

    await expect(generator.generate({
      prompt: "Animate",
      model: VIDEO_MODELS[1].id,
      duration: 6,
      resolution: "720p",
      aspectRatio: "adaptive",
      references: [
        { type: "image", name: "image.png", mediaType: "image/png", absolutePath: "/image.png" },
        { type: "video", name: "video.mp4", mediaType: "video/mp4", absolutePath: "/video.mp4" },
        { type: "audio", name: "audio.mp3", mediaType: "audio/mpeg", absolutePath: "/audio.mp3" },
      ],
    })).rejects.toThrow("blocked");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: VIDEO_MODELS[1].id,
      prompt: "Animate",
      seconds: "6",
      metadata: {
        resolution: "720p",
        ratio: "adaptive",
        content: [
          { type: "image_url", image_url: { url: "https://media.example/image.png" }, role: "reference_image" },
          { type: "video_url", video_url: { url: "https://media.example/video.mp4" }, role: "reference_video" },
          { type: "audio_url", audio_url: { url: "https://media.example/audio.mp3" }, role: "reference_audio" },
        ],
      },
    });
    expect(removeMedia.mock.calls.map(([id]) => id)).toEqual(["image-id", "video-id", "audio-id"]);
  });

  it("falls back to the authenticated content endpoint", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-content", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ data: { task_id: "task-content", status: "SUCCESS" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200 }));
    const generator = new ManagedVideoGenerator(() => source(), request);

    await expect(generator.generate({ prompt: "Animate", model: DEFAULT_VIDEO_MODEL, duration: 6, resolution: "720p", aspectRatio: "adaptive" }))
      .resolves.toMatchObject({ bytes: Buffer.from([4, 5, 6]), requestId: "task-content" });
    expect(request).toHaveBeenNthCalledWith(3, "https://account.example/v1/videos/task-content/content", expect.objectContaining({
      headers: { authorization: "Bearer secret" },
    }));
  });
});

function source(overrides: Partial<VideoSource> = {}): VideoSource {
  return {
    baseUrl: "https://account.example/v1",
    apiKey: "secret",
    modelIds: VIDEO_MODELS.map((model) => model.id),
    stageMedia: async () => ({ id: "staged", url: "https://media.example/reference" }),
    removeMedia: async () => undefined,
    ...overrides,
  };
}
