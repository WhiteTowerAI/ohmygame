import { describe, expect, it, vi } from "vitest";
import { PortalVideoGenerator } from "../src/daemon/minimax-video.js";

describe("Portal MiniMax video adapter", () => {
  it("creates, polls, and downloads a video through the New API contract", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task-1", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id: "task-1", status: "completed" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const generator = new PortalVideoGenerator(() => ({
      baseUrl: "https://portal.example/v1",
      apiKey: "secret",
      modelIds: ["MiniMax-H3"],
    }), request);

    await expect(generator.generate({ prompt: "Animate", duration: 6 }))
      .resolves.toMatchObject({ bytes: Buffer.from([1, 2, 3]), mediaType: "video/mp4", requestId: "task-1" });
    expect(request).toHaveBeenNthCalledWith(1, "https://portal.example/v1/videos", expect.objectContaining({ method: "POST" }));
    expect(request).toHaveBeenNthCalledWith(2, "https://portal.example/v1/videos/task-1", expect.objectContaining({
      headers: { authorization: "Bearer secret" },
    }));
    expect(request).toHaveBeenNthCalledWith(3, "https://portal.example/v1/videos/task-1/content", expect.any(Object));
    const form = request.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("model")).toBe("MiniMax-H3");
    expect(form.get("prompt")).toBe("Animate");
    expect(form.get("seconds")).toBe("6");
  });

  it("sends an image reference as input_reference", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task-2", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id: "task-2", status: "failed", error: { message: "blocked" } }));
    const generator = new PortalVideoGenerator(() => ({
      baseUrl: "https://portal.example/v1",
      apiKey: "secret",
      modelIds: ["MiniMax-H3"],
    }), request);

    await expect(generator.generate({ prompt: "Animate", duration: 6, image: { mediaType: "image/png", data: "aW1hZ2U=" } }))
      .rejects.toThrow("blocked");
    const form = request.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("input_reference")).toBeInstanceOf(File);
  });

  it("downloads the completed video's direct URL without forwarding the API key", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "task-direct", status: "queued" }))
      .mockResolvedValueOnce(Response.json({
        id: "task-direct",
        status: "completed",
        video_url: "https://files.example/video.mp4",
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5, 6]), { status: 200 }));
    const generator = new PortalVideoGenerator(() => ({
      baseUrl: "https://portal.example/v1",
      apiKey: "secret",
      modelIds: ["MiniMax-H3"],
    }), request);

    await expect(generator.generate({ prompt: "Animate", duration: 6 }))
      .resolves.toMatchObject({ bytes: Buffer.from([4, 5, 6]), requestId: "task-direct" });
    expect(request).toHaveBeenNthCalledWith(3, "https://files.example/video.mp4", { signal: undefined });
    expect(request.mock.calls[2]?.[1]?.headers).toBeUndefined();
  });
});
