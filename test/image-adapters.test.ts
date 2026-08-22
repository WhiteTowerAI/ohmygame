import { describe, expect, it, vi } from "vitest";
import { createImageProtocolAdapters } from "../src/daemon/image-adapters.js";

describe("image protocol adapters", () => {
  it("calls Gemini generateContent and decodes inline image data", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      responseId: "gemini-request",
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("png").toString("base64") } }] } }],
    }));
    const adapter = createImageProtocolAdapters(request)["gemini-generate-content"];

    await expect(adapter.generate(
      { baseUrl: "https://portal.open-game.ai/v1", apiKey: "sk-portal" },
      "gemini-2.5-flash-image",
      { prompt: "A game icon", size: "1536x1024" },
    )).resolves.toEqual({ bytes: Buffer.from("png"), mediaType: "image/png", requestId: "gemini-request" });

    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://portal.open-game.ai/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect(init?.headers).toEqual({ authorization: "Bearer sk-portal", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "A game icon" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } },
    });
  });

  it("maps Gemini errors and empty image responses", async () => {
    const rejected = createImageProtocolAdapters(async () => Response.json({ error: { message: "quota exceeded" } }, { status: 429 }))["gemini-generate-content"];
    await expect(rejected.generate({ baseUrl: "https://portal.open-game.ai/v1", apiKey: "key" }, "gemini-2.5-flash-image", { prompt: "image", size: "1024x1024" }))
      .rejects.toMatchObject({ message: "Gemini image generation is temporarily rate limited", statusCode: 429 });

    const empty = createImageProtocolAdapters(async () => Response.json({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }))["gemini-generate-content"];
    await expect(empty.generate({ baseUrl: "https://portal.open-game.ai/v1", apiKey: "key" }, "gemini-2.5-flash-image", { prompt: "image", size: "1024x1024" }))
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
