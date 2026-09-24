import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProviderImages } from "../src/daemon/provider-images.js";
import type { AccountConnection } from "../src/daemon/account-connection.js";

describe("ProviderImages", () => {
  it("lists supported image models for each connected provider", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(),
      vi.fn(async () => Response.json({ data: [{ id: "gpt-image-2.5-flare" }, { id: "text-only" }] })),
    );

    const models = await images.models();
    expect(models).toEqual([
      expect.objectContaining({ provider: "ohmygame", providerName: "OhMyGame account", id: "gpt-image-2.5-flare", name: "GPT Image 2.5" }),
      expect.objectContaining({ provider: "ohmygame", providerName: "OhMyGame account", id: "gemini-3.1-flash-image", name: "Nano Banana 2" }),
      expect.objectContaining({ provider: "openai", providerName: "OpenAI", id: "gpt-image-2.5-flare" }),
    ]);
    const gpt = models.find((model) => model.id === "gpt-image-2.5-flare");
    expect(new Set(gpt?.generationOptions.map((option) => option.resolution))).toEqual(new Set(["1K", "2K", "4K"]));
  });

  it("uses the explicitly selected provider and model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "gpt-image-2.5-flare" }] });
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] });
    });
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(),
      request,
    );

    await images.generate({ prompt: "A game icon", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" }, size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("https://api.openai.com/v1/images/generations");
    expect(generation?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/models"))).toHaveLength(1);
  });

  it("prefers the model supplied by a generation request", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }));
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(),
      request,
    );

    await images.generate({
      prompt: "A game icon",
      imageModel: { provider: "ohmygame", id: "gpt-image-2.5-flare" },
      resolution: "1K",
      aspectRatio: "1:1",
    });

    expect(request.mock.calls[0]?.[0]).toBe("https://account.ohmygame.ai/v1/images/generations");
    expect(request.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-account" }));
  });

  it("uses the preferred Account model by default without querying OpenAI", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("https://account.ohmygame.ai/v1/images/generations");
    expect(generation?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-account" }));
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(false);
  });

  it("queries OpenAI models once when selecting its default", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gemini-3.1-flash-image" }, { id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(false),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/models"))).toHaveLength(1);
    expect(request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"))?.[0])
      .toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ model: "gpt-image-2.5-flare" });
  });

  it("validates the selected model's supported sizes", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(),
      vi.fn(),
    );

    await expect(images.generate({ prompt: "A game icon", imageModel: { provider: "ohmygame", id: "gpt-image-2.5-flare" }, size: "invalid" as never }))
      .rejects.toMatchObject({ message: "Image size is not supported by the selected model", statusCode: 400 });
  });

  it("validates configured resolution and aspect-ratio combinations", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }));
    const images = new ProviderImages(
      async () => runtime(),
      accountConnection(),
      request,
    );

    const imageModel = { provider: "ohmygame", id: "gpt-image-2.5-flare" };
    await expect(images.generate({ prompt: "A game icon", imageModel, resolution: "512", aspectRatio: "1:1" }))
      .rejects.toMatchObject({ message: "Image resolution and aspect ratio are not supported by the selected model", statusCode: 400 });
    await expect(images.generate({ prompt: "A game icon", imageModel, resolution: "4K", aspectRatio: "1:1" })).resolves.toMatchObject({ mediaType: "image/webp" });
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

function accountConnection(connected = true): AccountConnection {
  return {
    imageSource: () => connected ? ({
      baseUrl: "https://account.ohmygame.ai/v1",
      apiKey: "sk-account",
      modelIds: ["gemini-3.1-flash-image", "gpt-image-2.5-flare", "text-only"],
    }) : undefined,
  } as unknown as AccountConnection;
}
