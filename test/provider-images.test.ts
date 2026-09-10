import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProviderImages } from "../src/daemon/provider-images.js";
import type { PortalConnection } from "../src/daemon/portal-connection.js";

describe("ProviderImages", () => {
  it("lists supported image models for each connected provider", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      portal(),
      () => undefined,
      vi.fn(async () => Response.json({ data: [{ id: "gpt-image-2" }, { id: "text-only" }] })),
    );

    const models = await images.models();
    expect(models).toEqual([
      expect.objectContaining({ provider: "opengame", providerName: "OpenGame Portal", id: "gpt-image-2" }),
      expect.objectContaining({ provider: "opengame", providerName: "OpenGame Portal", id: "gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite" }),
      expect.objectContaining({ provider: "opengame", providerName: "OpenGame Portal", id: "gemini-3.1-flash-image", name: "Nano Banana 2" }),
      expect.objectContaining({ provider: "openai", providerName: "OpenAI", id: "gpt-image-2" }),
    ]);
    const gpt = models.find((model) => model.id === "gpt-image-2");
    expect(new Set(gpt?.generationOptions.map((option) => option.resolution))).toEqual(new Set(["1K", "2K", "4K"]));
  });

  it("uses the explicitly selected provider and model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "gpt-image-2" }] });
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] });
    });
    const images = new ProviderImages(
      async () => runtime(),
      portal(),
      () => ({ provider: "openai", id: "gpt-image-2" }),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("https://api.openai.com/v1/images/generations");
    expect(generation?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
  });

  it("prefers the model supplied by a generation request", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }));
    const images = new ProviderImages(
      async () => runtime(),
      portal(),
      () => ({ provider: "openai", id: "gpt-image-2" }),
      request,
    );

    await images.generate({
      prompt: "A game icon",
      imageModel: { provider: "opengame", id: "gpt-image-2" },
      resolution: "1K",
      aspectRatio: "1:1",
    });

    expect(request.mock.calls[0]?.[0]).toBe("https://portal.open-game.ai/v1/images/generations");
    expect(request.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-portal" }));
  });

  it("uses a selected Portal model without querying unrelated providers", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }));
    const images = new ProviderImages(
      async () => runtime(),
      portal(),
      () => ({ provider: "opengame", id: "gpt-image-2" }),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("https://portal.open-game.ai/v1/images/generations");
    expect(request.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-portal" }));
  });

  it("validates the selected model's supported sizes", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      portal(),
      () => ({ provider: "opengame", id: "gpt-image-2" }),
      vi.fn(),
    );

    await expect(images.generate({ prompt: "A game icon", size: "invalid" as never }))
      .rejects.toMatchObject({ message: "Image size is not supported by the selected model", statusCode: 400 });
  });

  it("validates Asset Studio resolution and aspect-ratio combinations", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }));
    const images = new ProviderImages(
      async () => runtime(),
      portal(),
      () => ({ provider: "opengame", id: "gpt-image-2" }),
      request,
    );

    await expect(images.generate({ prompt: "A game icon", resolution: "512", aspectRatio: "1:1" }))
      .rejects.toMatchObject({ message: "Image resolution and aspect ratio are not supported by the selected model", statusCode: 400 });
    await expect(images.generate({ prompt: "A game icon", resolution: "4K", aspectRatio: "1:1" })).resolves.toMatchObject({ mediaType: "image/webp" });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ size: "2880x2880" });
  });
});

function runtime(): ModelRuntime {
  return {
    getProvider: (provider: string) => provider === "openai"
      ? { name: "OpenAI", baseUrl: "https://api.openai.com/v1" }
      : undefined,
    hasConfiguredAuth: (provider: string) => provider === "openai",
    getAuth: async () => ({ auth: { apiKey: "sk-openai" }, source: "test" }),
  } as unknown as ModelRuntime;
}

function portal(): PortalConnection {
  return {
    imageSource: () => ({
      baseUrl: "https://portal.open-game.ai/v1",
      apiKey: "sk-portal",
      modelIds: ["gpt-image-2", "gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "text-only"],
    }),
  } as unknown as PortalConnection;
}
