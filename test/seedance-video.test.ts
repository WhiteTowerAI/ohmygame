import { describe, expect, it, vi } from "vitest";
import { PortalVideoGenerator } from "../src/daemon/seedance-video.js";
import { VIDEO_MODEL } from "../src/shared/contracts.js";

describe("Portal Seedance video adapter", () => {
  it("creates, polls, and downloads a video through the New API contract", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-1", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ data: { task_id: "task-1", status: "SUCCESS", result_url: "https://files.example/video.mp4" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const generator = new PortalVideoGenerator(() => ({
      baseUrl: "https://portal.example/v1",
      apiKey: "secret",
      modelIds: [VIDEO_MODEL],
    }), request);

    await expect(generator.generate({ prompt: "Animate", duration: 6, resolution: "1080p", aspectRatio: "21:9" }))
      .resolves.toMatchObject({ bytes: Buffer.from([1, 2, 3]), mediaType: "video/mp4", requestId: "task-1" });
    expect(request).toHaveBeenNthCalledWith(1, "https://portal.example/v1/video/generations", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
    }));
    expect(request).toHaveBeenNthCalledWith(2, "https://portal.example/v1/video/generations/task-1", expect.objectContaining({
      headers: { authorization: "Bearer secret" },
    }));
    expect(request).toHaveBeenNthCalledWith(3, "https://files.example/video.mp4", { signal: undefined });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: VIDEO_MODEL,
      prompt: "Animate",
      seconds: "6",
      metadata: { resolution: "1080p", ratio: "21:9" },
    });
  });

  it("sends multiple image references as data URLs", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-2", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ data: { task_id: "task-2", status: "FAILURE", fail_reason: "blocked" } }));
    const generator = new PortalVideoGenerator(() => ({
      baseUrl: "https://portal.example/v1",
      apiKey: "secret",
      modelIds: [VIDEO_MODEL],
    }), request);

    await expect(generator.generate({
      prompt: "Animate",
      duration: 6,
      resolution: "720p",
      aspectRatio: "adaptive",
      images: [
        { mediaType: "image/png", data: "aW1hZ2U=" },
        { mediaType: "image/webp", data: "aW1hZ2Uy" },
      ],
    })).rejects.toThrow("blocked");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      images: ["data:image/png;base64,aW1hZ2U=", "data:image/webp;base64,aW1hZ2Uy"],
    });
  });

  it("falls back to the authenticated content endpoint", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-content", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ data: { task_id: "task-content", status: "SUCCESS" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200 }));
    const generator = new PortalVideoGenerator(() => ({
      baseUrl: "https://portal.example/v1",
      apiKey: "secret",
      modelIds: [VIDEO_MODEL],
    }), request);

    await expect(generator.generate({ prompt: "Animate", duration: 6, resolution: "720p", aspectRatio: "adaptive" }))
      .resolves.toMatchObject({ bytes: Buffer.from([4, 5, 6]), requestId: "task-content" });
    expect(request).toHaveBeenNthCalledWith(3, "https://portal.example/v1/videos/task-content/content", expect.objectContaining({
      headers: { authorization: "Bearer secret" },
    }));
  });
});
