import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { seedanceModel } from "../src/daemon/seedance-models.js";
import { SeedanceProvider } from "../src/daemon/seedance-provider.js";

describe("Seedance provider", () => {
  it("creates, polls, and downloads a Volcengine first-and-last-frame video", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-provider-"));
    const first = path.join(directory, "first.png");
    const last = path.join(directory, "last.jpeg");
    await Promise.all([writeFile(first, Buffer.from("first")), writeFile(last, Buffer.from("last"))]);
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "cgt-1" }))
      .mockResolvedValueOnce(Response.json({ status: "queued" }))
      .mockResolvedValueOnce(Response.json({ status: "running" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "https://files.example/video.mp4" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const provider = new SeedanceProvider("volcengine-ark", () => "volc-key", request, 0);
    const model = seedanceModel("volcengine-ark", "doubao-seedance-2-0-260128")!;

    await expect(provider.generate(model, {
      prompt: "A ship crosses a storm",
      model,
      references: [
        { type: "image", name: "first.png", mediaType: "IMAGE/PNG", absolutePath: first },
        { type: "image", name: "last.jpeg", mediaType: "image/jpeg", absolutePath: last },
      ],
      duration: 8,
      resolution: "4K",
      aspectRatio: "16:9",
    })).resolves.toEqual({ bytes: Buffer.from([1, 2, 3]), mediaType: "video/mp4", requestId: "cgt-1" });

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-1",
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-1",
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-1",
      "https://files.example/video.mp4",
    ]);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer volc-key", "content-type": "application/json" });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: "doubao-seedance-2-0-260128",
      content: [
        { type: "text", text: "A ship crosses a storm" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("first").toString("base64")}` }, role: "first_frame" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("last").toString("base64")}` }, role: "last_frame" },
      ],
      resolution: "4k",
      ratio: "16:9",
      duration: 8,
      generate_audio: false,
      watermark: false,
    });
    expect(request.mock.calls[4]?.[1]?.headers).toBeUndefined();
  });

  it("uses the BytePlus endpoint for text-to-video", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "cgt-world" }))
      .mockResolvedValueOnce(Response.json({ status: "succeeded", content: { video_url: "https://files.example/world.mp4" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    const provider = new SeedanceProvider("byteplus-modelark", () => "world-key", request, 0);
    const model = seedanceModel("byteplus-modelark", "dreamina-seedance-2-5-260628")!;

    await expect(provider.generate(model, { prompt: "A paper city unfolds", model, duration: 5, resolution: "720p", aspectRatio: "21:9" }))
      .resolves.toMatchObject({ requestId: "cgt-world" });
    expect(request.mock.calls[0]?.[0]).toBe("https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks");
  });

  it("enforces Seedance 2.5 image-mode ratios before sending a request", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new SeedanceProvider("byteplus-modelark", () => "world-key", request, 0);
    const model = seedanceModel("byteplus-modelark", "dreamina-seedance-2-5-260628")!;

    await expect(provider.generate(model, {
      prompt: "Animate",
      model,
      references: [{ type: "image", name: "frame.png", mediaType: "image/png", absolutePath: "unused" }],
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
    })).rejects.toMatchObject({ message: "Video aspect ratio is not supported by the selected model and reference mode", statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports missing credentials and official task failures", async () => {
    const model = seedanceModel("volcengine-ark", "doubao-seedance-2-0-260128")!;
    await expect(new SeedanceProvider("volcengine-ark", () => undefined).generate(model, { prompt: "test", model }))
      .rejects.toMatchObject({ message: "Volcengine Ark API key is not configured", statusCode: 503 });

    const failedRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "cgt-failed" }))
      .mockResolvedValueOnce(Response.json({ status: "failed", error: { message: "Model is not activated" } }));
    await expect(new SeedanceProvider("volcengine-ark", () => "key", failedRequest, 0).generate(model, { prompt: "test", model }))
      .rejects.toMatchObject({ message: "Model is not activated", statusCode: 400 });
  });

  it.each([
    [401, "Volcengine Ark credentials were rejected", 503],
    [429, "Volcengine Ark video generation is temporarily rate limited", 429],
    [500, "Volcengine Ark: unavailable", 502],
  ])("maps an HTTP %s response to a useful error", async (status, message, statusCode) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: status === 500 ? "unavailable" : "ignored" } }, { status }));
    const provider = new SeedanceProvider("volcengine-ark", () => "key", request, 0);
    const model = seedanceModel("volcengine-ark", "doubao-seedance-2-0-260128")!;
    await expect(provider.generate(model, { prompt: "test", model })).rejects.toMatchObject({ message, statusCode });
  });
});
