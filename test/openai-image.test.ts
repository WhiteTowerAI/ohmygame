import { describe, expect, it, vi } from "vitest";
import { ImageGenerationError, OpenAIImageGenerator } from "../src/daemon/openai-image.js";

describe("OpenAI image generator", () => {
  it("calls GPT Image 2 through the native Images API", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("generated image").toString("base64") }],
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "request-123" },
    }));
    const generator = new OpenAIImageGenerator("secret-key", "https://images.example/v1/", request);

    const result = await generator.generate({ prompt: "A game icon", size: "1024x1024" });

    expect(result).toEqual({
      bytes: Buffer.from("generated image"),
      mediaType: "image/webp",
      requestId: "request-123",
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://images.example/v1/images/generations");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      authorization: "Bearer secret-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2",
      prompt: "A game icon",
      size: "1024x1024",
      quality: "medium",
      output_format: "webp",
      n: 1,
    });
  });

  it("maps authentication and moderation errors without exposing provider details", async () => {
    const unauthorized = new OpenAIImageGenerator("bad-key", undefined, async () => new Response(JSON.stringify({
      error: { message: "Incorrect API key" },
    }), { status: 401 }));
    await expect(unauthorized.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
      message: "OpenAI API key was rejected",
      statusCode: 503,
    });

    const blocked = new OpenAIImageGenerator("key", undefined, async () => new Response(JSON.stringify({
      error: { code: "moderation_blocked", message: "blocked" },
    }), { status: 400 }));
    await expect(blocked.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
      message: "The image request did not meet safety requirements",
      statusCode: 400,
    });
  });

  it("uses multipart image edits when a reference is provided", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: Buffer.from("edited").toString("base64") }],
    }));
    const generator = new OpenAIImageGenerator("key", "https://images.example/v1", request);

    await generator.generate({
      prompt: "Turn this into concept art",
      resolution: "1K",
      aspectRatio: "3:2",
      images: [{ mediaType: "image/png", data: Buffer.from("reference").toString("base64") }],
    });

    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://images.example/v1/images/edits");
    expect(init?.headers).toEqual({ authorization: "Bearer key" });
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("prompt")).toBe("Turn this into concept art");
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("image[]")).toBeInstanceOf(Blob);
  });

  it("uploads multiple reference images as image[]", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const generator = new OpenAIImageGenerator("sk-test", "https://api.openai.com/v1", request);

    await generator.generate({ prompt: "Compose references", size: "1536x1024", images: [
      { mediaType: "image/png", data: "b25l" },
      { mediaType: "image/jpeg", data: "dHdv" },
    ] });

    const form = request.mock.calls[0]?.[1]?.body as FormData;
    expect(form.getAll("image[]")).toHaveLength(2);
  });

  it.each([
    ["1K", "21:9", "1456x624"],
    ["2K", "1:1", "2048x2048"],
    ["2K", "16:9", "2048x1152"],
    ["4K", "1:1", "2880x2880"],
    ["4K", "16:9", "3840x2160"],
  ] as const)("maps %s %s Asset Studio output to %s", async (resolution, aspectRatio, size) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }));
    const generator = new OpenAIImageGenerator("key", "https://images.example/v1", request);

    await generator.generate({ prompt: "A game icon", resolution, aspectRatio });

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ size });
  });

  it("rejects the unsupported 512px output tier", async () => {
    const request = vi.fn<typeof fetch>();
    const generator = new OpenAIImageGenerator("key", undefined, request);

    await expect(generator.generate({ prompt: "A game icon", resolution: "512", aspectRatio: "1:1" }))
      .rejects.toMatchObject({ message: "Image resolution and aspect ratio are not supported by the selected model", statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("requires configuration and rejects empty image responses", async () => {
    await expect(new OpenAIImageGenerator(undefined).generate({ prompt: "image", size: "1024x1024" }))
      .rejects.toEqual(new ImageGenerationError("Image generation is not configured", 503));

    const generator = new OpenAIImageGenerator("key", undefined, async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(generator.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
      message: "OpenAI returned no generated image",
      statusCode: 502,
    });
  });

  it("rejects invalid base URLs before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    for (const baseUrl of ["not-a-url", "https://images.example/v1?route=test", "https://images.example/v1#test"]) {
      const generator = new OpenAIImageGenerator("key", baseUrl, request);
      await expect(generator.generate({ prompt: "image", size: "1024x1024" })).rejects.toMatchObject({
        message: "OpenAI base URL is not valid",
        statusCode: 503,
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation", async () => {
    const request = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const generator = new OpenAIImageGenerator("key", undefined, request);
    const controller = new AbortController();

    const generation = generator.generate({ prompt: "image", size: "1024x1024" }, controller.signal);
    controller.abort();

    await expect(generation).rejects.toMatchObject({ name: "AbortError" });
  });

});
