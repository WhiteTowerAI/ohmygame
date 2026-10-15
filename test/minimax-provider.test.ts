import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { minimaxModel } from "../src/daemon/minimax-models.js";
import { MinimaxProvider } from "../src/daemon/minimax-provider.js";

describe("Minimax provider", () => {
  it("creates, polls, and downloads a China first-and-last-frame video", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-minimax-provider-"));
    const first = path.join(directory, "first.png");
    const last = path.join(directory, "last.jpeg");
    await Promise.all([writeFile(first, Buffer.from("first")), writeFile(last, Buffer.from("last"))]);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ task_id: "mm-1" }))
      .mockResolvedValueOnce(Response.json({ task: { status: "queued" } }))
      .mockResolvedValueOnce(Response.json({ task: { status: "succeeded", content: { url: "https://files.example/video.mp4" } } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const provider = new MinimaxProvider("minimax-video-cn", () => "mm-key", request, 0);
    const model = minimaxModel("minimax-video-cn", "MiniMax-H3")!;

    await expect(provider.generate(model, {
      prompt: "A ship crosses a storm",
      model,
      references: [
        { type: "image", name: "first.png", mediaType: "IMAGE/PNG", absolutePath: first },
        { type: "image", name: "last.jpeg", mediaType: "image/jpeg", absolutePath: last },
      ],
      duration: 8,
      resolution: "2K",
      aspectRatio: "adaptive",
    })).resolves.toEqual({ bytes: Buffer.from([1, 2, 3]), mediaType: "video/mp4", requestId: "mm-1" });

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.minimax.cn/v2/video_generation",
      "https://api.minimax.cn/v2/query/video_generation/mm-1",
      "https://api.minimax.cn/v2/query/video_generation/mm-1",
      "https://files.example/video.mp4",
    ]);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer mm-key", "content-type": "application/json" });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: "MiniMax-H3",
      content: [
        { type: "text", text: "A ship crosses a storm" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("first").toString("base64")}` }, role: "first_frame" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("last").toString("base64")}` }, role: "last_frame" },
      ],
      resolution: "2K",
      ratio: "adaptive",
      duration: 8,
    });
  });

  it("uses the global endpoint and uppercases resolution for text-to-video", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ task_id: "mm-world" }))
      .mockResolvedValueOnce(Response.json({ task: { status: "succeeded", content: { url: "https://files.example/world.mp4" } } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    const provider = new MinimaxProvider("minimax-video-global", () => "world-key", request, 0);
    const model = minimaxModel("minimax-video-global", "MiniMax-H3-Max")!;

    await expect(provider.generate(model, { prompt: "A paper city unfolds", model, duration: 6, resolution: "768p", aspectRatio: "16:9" }))
      .resolves.toMatchObject({ requestId: "mm-world" });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.minimax.io/v2/video_generation");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "MiniMax-H3-Max", resolution: "768P", ratio: "16:9", duration: 6 });
  });

  it("enforces frame-mode adaptive ratio before sending a request", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new MinimaxProvider("minimax-video-cn", () => "mm-key", request, 0);
    const model = minimaxModel("minimax-video-cn", "MiniMax-H3")!;

    await expect(provider.generate(model, {
      prompt: "Animate",
      model,
      references: [{ type: "image", name: "frame.png", mediaType: "image/png", absolutePath: "unused" }],
      duration: 6,
      resolution: "768p",
      aspectRatio: "16:9",
    })).rejects.toMatchObject({ message: "Video aspect ratio is not supported by the selected model and reference mode", statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports missing credentials and official task failures", async () => {
    const model = minimaxModel("minimax-video-cn", "MiniMax-H3")!;
    await expect(new MinimaxProvider("minimax-video-cn", () => undefined).generate(model, { prompt: "test", model }))
      .rejects.toMatchObject({ message: "MiniMax China API key is not configured", statusCode: 503 });

    const failedRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ task_id: "mm-failed" }))
      .mockResolvedValueOnce(Response.json({ task: { status: "failed", error: { message: "Model is not activated" } } }));
    await expect(new MinimaxProvider("minimax-video-cn", () => "key", failedRequest, 0).generate(model, { prompt: "test", model }))
      .rejects.toMatchObject({ message: "Model is not activated", statusCode: 400 });
  });

  it.each([
    [401, "MiniMax China credentials were rejected", 503],
    [429, "MiniMax China video generation is temporarily rate limited", 429],
    [500, "MiniMax China: unavailable", 502],
  ])("maps an HTTP %s response to a useful error", async (status, message, statusCode) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: status === 500 ? "unavailable" : "ignored" } }, { status }));
    const provider = new MinimaxProvider("minimax-video-cn", () => "key", request, 0);
    const model = minimaxModel("minimax-video-cn", "MiniMax-H3")!;
    await expect(provider.generate(model, { prompt: "test", model })).rejects.toMatchObject({ message, statusCode });
  });
});
