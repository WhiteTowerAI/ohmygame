import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProviderImages } from "../src/daemon/provider-images.js";

describe("ProviderImages", () => {
  it("lists and generates with the configured Volcengine Ark Seedream models", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: [{ b64_json: Buffer.from("seedream").toString("base64"), output_format: "png" }],
    }));
    const images = new ProviderImages(async () => { throw new Error("Runtime unavailable"); }, request, () => "volc-key");

    const catalog = await images.catalog();
    expect(catalog.providers).toEqual([
      { provider: "volcengine-ark", providerName: "Volcengine Ark", state: "ready" },
    ]);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "doubao-seedream-5-0-pro-260628",
      "doubao-seedream-5-0-flash-260915",
      "doubao-seedream-5-0-260128",
    ]);
    expect(catalog.models).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "doubao-seedream-5-0-lite-260128" }),
    ]));

    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "volcengine-ark", id: "doubao-seedream-5-0-flash-260915" },
      resolution: "1K",
      aspectRatio: "1:1",
    })).resolves.toMatchObject({ bytes: Buffer.from("seedream"), mediaType: "image/png" });
    expect(request.mock.calls[0]?.[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
  });

  it("lists and generates with a configured OpenRouter image model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/images/models")
      ? Response.json({ data: [{
          id: "openai/gpt-image-2.5-flare",
          name: "OpenAI: GPT Image 2.5 Flare",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
          supported_parameters: {
            resolution: { type: "enum", values: ["1K", "2K"] },
            aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
          },
        }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64"), media_type: "image/png" }] }));
    const images = new ProviderImages(async () => openRouterRuntime(), request);

    await expect(images.models()).resolves.toEqual([
      expect.objectContaining({ provider: "openrouter", id: "openai/gpt-image-2.5-flare", protocol: "openrouter-images" }),
    ]);
    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openrouter", id: "openai/gpt-image-2.5-flare" },
      resolution: "2K",
      aspectRatio: "16:9",
    })).resolves.toMatchObject({ bytes: Buffer.from("image"), mediaType: "image/png" });
    expect(request.mock.calls.find(([input]) => String(input).endsWith("/images"))?.[0]).toBe("https://openrouter.ai/api/v1/images");
  });

  it("lists supported image models for each connected provider", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      vi.fn(async () => Response.json({ data: [{ id: "gpt-image-2.5-flare" }, { id: "text-only" }] })),
    );

    const models = await images.models();
    expect(models).toEqual([
      expect.objectContaining({ provider: "openai", providerName: "OpenAI", id: "gpt-image-2.5-flare" }),
    ]);
    const gpt = models.find((model) => model.id === "gpt-image-2.5-flare");
    expect(new Set(gpt?.generationOptions.map((option) => option.resolution))).toEqual(new Set(["1K", "2K", "4K"]));
  });

  it("explains that a ChatGPT sign-in cannot generate images without asking OpenAI", async () => {
    const request = vi.fn<typeof fetch>();
    const images = new ProviderImages(
      async () => ({ ...runtime(), listCredentials: async () => [{ providerId: "openai", type: "oauth" }] }) as unknown as ModelRuntime,
      request,
    );

    const catalog = await images.catalog();

    expect(catalog.models).toEqual([]);
    expect(catalog.providers).toEqual([expect.objectContaining({ provider: "openai", state: "empty", message: expect.stringContaining("connect OpenAI with an API key instead, or connect OpenRouter") })]);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports an OpenAI catalog failure", async () => {
    const images = new ProviderImages(async () => runtime(), vi.fn(async () => new Response("{}", { status: 500 })));

    expect((await images.catalog()).providers).toEqual([expect.objectContaining({ provider: "openai", state: "error", message: "Model request failed (500)" })]);
  });

  it("reports a connected provider without supported image models", async () => {
    const images = new ProviderImages(
      async () => ({ ...runtime(), listCredentials: async () => [] }) as unknown as ModelRuntime,
      vi.fn(async () => Response.json({ data: [{ id: "text-only" }] })),
    );

    expect((await images.catalog()).providers).toEqual([
      { provider: "openai", providerName: "OpenAI", state: "empty", message: "This OpenAI key or endpoint lists no GPT Image models." },
    ]);
  });

  it("uses the explicitly selected provider and model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "gpt-image-2.5-flare" }] });
      return Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] });
    });
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await images.generate({ prompt: "A game icon", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" }, size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("https://api.openai.com/v1/images/generations");
    expect(generation?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
    expect(request.mock.calls.filter(([input]) => String(input) === "https://api.openai.com/v1/models")).toHaveLength(1);
  });

  it("prefers the model supplied by a generation request", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await expect(images.generate({
      prompt: "A game icon",
      imageModel: { provider: "openai", id: "gpt-image-2.5-flare" },
      resolution: "1K",
      aspectRatio: "1:1",
    })).resolves.toBeDefined();

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("https://api.openai.com/v1/images/generations");
    expect(generation?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
  });

  it("uses a configured BYOK model before the legacy Account model", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    const generation = request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"));
    expect(generation?.[0]).toBe("https://api.openai.com/v1/images/generations");
    expect(generation?.[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer sk-openai" }));
    expect(request.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(true);
  });

  it("queries OpenAI models once when selecting its default", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gemini-3.1-flash-image" }, { id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    await images.generate({ prompt: "A game icon", size: "1024x1024" });

    expect(request.mock.calls.filter(([input]) => String(input) === "https://api.openai.com/v1/models")).toHaveLength(1);
    expect(request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"))?.[0])
      .toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(request.mock.calls.find(([input]) => String(input).endsWith("/images/generations"))?.[1]?.body))).toMatchObject({ model: "gpt-image-2.5-flare" });
  });

  it("validates the selected model's supported sizes", async () => {
    const images = new ProviderImages(
      async () => runtime(),
      vi.fn(async (input) => String(input).endsWith("/models") ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] }) : Response.json({ data: [] })),
    );

    await expect(images.generate({ prompt: "A game icon", imageModel: { provider: "openai", id: "gpt-image-2.5-flare" }, size: "invalid" as never }))
      .rejects.toMatchObject({ message: "Image size is not supported by the selected model", statusCode: 400 });
  });

  it("validates configured resolution and aspect-ratio combinations", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-image-2.5-flare" }] })
      : Response.json({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }));
    const images = new ProviderImages(
      async () => runtime(),
      request,
    );

    const imageModel = { provider: "openai", id: "gpt-image-2.5-flare" };
    await expect(images.generate({ prompt: "A game icon", imageModel, resolution: "512", aspectRatio: "1:1" }))
      .rejects.toMatchObject({ message: "Image resolution and aspect ratio are not supported by the selected model", statusCode: 400 });
  });
});

function runtime(): ModelRuntime {
  return {
    getProvider: (provider: string) => provider === "openai"
      ? { name: "OpenAI", baseUrl: "https://api.openai.com/v1" }
      : undefined,
    hasConfiguredAuth: (provider: string) => provider === "openai",
    getAuth: async () => ({ auth: { apiKey: "sk-openai" }, source: "test" }),
    listCredentials: async () => [{ providerId: "openai", type: "api_key" }],
  } as unknown as ModelRuntime;
}

function openRouterRuntime(): ModelRuntime {
  return {
    getProvider: (provider: string) => provider === "openrouter"
      ? { id: provider, name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }
      : undefined,
    hasConfiguredAuth: (provider: string) => provider === "openrouter",
    getAuth: async () => ({ auth: { apiKey: "sk-openrouter" }, source: "test" }),
  } as unknown as ModelRuntime;
}
