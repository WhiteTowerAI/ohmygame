import { describe, expect, it, vi } from "vitest";
import { createImageProtocolAdapters } from "../src/daemon/image-adapters.js";

describe("image protocol adapters", () => {
  it("calls the OpenRouter Image API and decodes its result", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: Buffer.from("openrouter").toString("base64"), media_type: "image/webp" }],
    }, { headers: { "x-request-id": "or-image-1" } }));
    const adapter = createImageProtocolAdapters(request)["openrouter-images"];

    await expect(adapter.generate(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", headers: { "x-openrouter-title": "OhMyGame" } },
      "openai/gpt-image-2.5-flare",
      { prompt: "A game icon", resolution: "2K", aspectRatio: "16:9", images: [{ mediaType: "image/png", data: "cmVm" }] },
    )).resolves.toEqual({ bytes: Buffer.from("openrouter"), mediaType: "image/webp", requestId: "or-image-1" });

    expect(request.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/images");
    expect(request.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-or", "x-openrouter-title": "OhMyGame" }));
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: "openai/gpt-image-2.5-flare",
      prompt: "A game icon",
      resolution: "2K",
      aspect_ratio: "16:9",
      input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,cmVm" } }],
    });
  });

  it("calls Gemini generateContent and decodes inline image data", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      responseId: "gemini-request",
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("png").toString("base64") } }] } }],
    }));
    const adapter = createImageProtocolAdapters(request)["gemini-generate-content"];

    await expect(adapter.generate(
      { baseUrl: "https://generativelanguage.googleapis.com/v1", apiKey: "sk-google" },
      "gemini-2.5-flash-image",
      { prompt: "A game icon", size: "1536x1024" },
    )).resolves.toEqual({ bytes: Buffer.from("png"), mediaType: "image/png", requestId: "gemini-request" });

    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect(init?.headers).toEqual({ authorization: "Bearer sk-google", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "A game icon" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
    });
  });

  it("passes a reference image and aspect ratio to Gemini", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/webp", data: Buffer.from("webp").toString("base64") } }] } }],
    }));
    const adapter = createImageProtocolAdapters(request)["gemini-generate-content"];

    await adapter.generate(
      { baseUrl: "https://generativelanguage.googleapis.com/v1", apiKey: "key" },
      "gemini-2.5-flash-image",
      { prompt: "A game icon", resolution: "1K", aspectRatio: "4:3", images: [{ mediaType: "image/webp", data: "cmVmZXJlbmNl" }] },
    );

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      contents: [{ role: "user", parts: [
        { text: "A game icon" },
        { inlineData: { mimeType: "image/webp", data: "cmVmZXJlbmNl" } },
      ] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "4:3", imageSize: "1K" } },
    });
  });

  it("passes multiple reference images to Gemini", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "cG5n" } }] } }],
    }));
    const adapter = createImageProtocolAdapters(request)["gemini-generate-content"];

    await adapter.generate(
      { baseUrl: "https://generativelanguage.googleapis.com/v1", apiKey: "key" },
      "gemini-3.1-flash-image",
      { prompt: "Compose these references", resolution: "2K", aspectRatio: "16:9", images: [
        { mediaType: "image/png", data: "b25l" },
        { mediaType: "image/jpeg", data: "dHdv" },
      ] },
    );

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).contents[0].parts).toEqual([
      { text: "Compose these references" },
      { inlineData: { mimeType: "image/png", data: "b25l" } },
      { inlineData: { mimeType: "image/jpeg", data: "dHdv" } },
    ]);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).generationConfig.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "2K" });
  });

  it("maps Gemini errors and empty image responses", async () => {
    const rejected = createImageProtocolAdapters(async () => Response.json({ error: { message: "quota exceeded" } }, { status: 429 }))["gemini-generate-content"];
    await expect(rejected.generate({ baseUrl: "https://generativelanguage.googleapis.com/v1", apiKey: "key" }, "gemini-2.5-flash-image", { prompt: "image", size: "1024x1024" }))
      .rejects.toMatchObject({ message: "Gemini image generation is temporarily rate limited", statusCode: 429 });

    const empty = createImageProtocolAdapters(async () => Response.json({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }))["gemini-generate-content"];
    await expect(empty.generate({ baseUrl: "https://generativelanguage.googleapis.com/v1", apiKey: "key" }, "gemini-2.5-flash-image", { prompt: "image", size: "1024x1024" }))
      .rejects.toMatchObject({ message: "Gemini returned no generated image", statusCode: 502 });
  });

  it("preserves a native v1beta URL and rejects unknown image formats", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/gif", data: "Z2lm" } }] } }],
    }));
    const adapter = createImageProtocolAdapters(request)["gemini-generate-content"];
    await expect(adapter.generate({ baseUrl: "https://generativelanguage.example/v1beta", apiKey: "key" }, "gemini-2.5-flash-image", { prompt: "image", size: "1024x1024" }))
      .rejects.toMatchObject({ message: "Gemini returned an unsupported image format" });
    expect(request.mock.calls[0]?.[0]).toBe("https://generativelanguage.example/v1beta/models/gemini-2.5-flash-image:generateContent");
  });
});
