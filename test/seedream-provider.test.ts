import { describe, expect, it, vi } from "vitest";
import { seedreamModel } from "../src/daemon/seedream-models.js";
import { SeedreamProvider } from "../src/daemon/seedream-provider.js";

describe("Seedream provider", () => {
  it("generates a Pro image with references and the documented pixel size", async () => {
    const encoded = Buffer.from("generated-image").toString("base64");
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      model: "doubao-seedream-5-0-pro-260628",
      data: [{ b64_json: encoded, output_format: "png", size: "2816x1584" }],
    }, { headers: { "x-request-id": "image-request-1" } }));
    const provider = new SeedreamProvider(() => "volc-key", request);
    const model = seedreamModel("doubao-seedream-5-0-pro-260628")!;

    await expect(provider.generate(model, {
      prompt: "A game splash screen",
      imageModel: model,
      resolution: "2K",
      aspectRatio: "16:9",
      images: [
        { mediaType: "image/png", data: Buffer.from("first").toString("base64") },
        { mediaType: "image/jpeg", data: Buffer.from("second").toString("base64") },
      ],
    })).resolves.toEqual({ bytes: Buffer.from("generated-image"), mediaType: "image/png", requestId: "image-request-1" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer volc-key", "content-type": "application/json" });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: "doubao-seedream-5-0-pro-260628",
      prompt: "A game splash screen",
      image: [
        `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
        `data:image/jpeg;base64,${Buffer.from("second").toString("base64")}`,
      ],
      size: "2816x1584",
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
    });
  });

  it("keeps the current Seedream 5.0 model in single-image mode", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64"), output_format: "png" }],
    }));
    const provider = new SeedreamProvider(() => "volc-key", request);
    const model = seedreamModel("doubao-seedream-5-0-260128")!;

    await provider.generate(model, { prompt: "Icon", imageModel: model, resolution: "2K", aspectRatio: "1:1" });

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "doubao-seedream-5-0-260128",
      size: "2048x2048",
      sequential_image_generation: "disabled",
    });
  });

  it("validates credentials, reference count, and official errors", async () => {
    const model = seedreamModel("doubao-seedream-5-0-flash-260915")!;
    await expect(new SeedreamProvider(() => undefined).generate(model, {
      prompt: "test",
      resolution: "1K",
      aspectRatio: "1:1",
    })).rejects.toMatchObject({ message: "Volcengine Ark API key is not configured", statusCode: 503 });

    const tooMany = Array.from({ length: 11 }, () => ({ mediaType: "image/png" as const, data: "aW1hZ2U=" }));
    await expect(new SeedreamProvider(() => "key").generate(model, {
      prompt: "test",
      resolution: "1K",
      aspectRatio: "1:1",
      images: tooMany,
    })).rejects.toMatchObject({ message: "The selected image model supports up to 10 reference images", statusCode: 400 });

    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: "Model is not activated" } }, { status: 400 }));
    await expect(new SeedreamProvider(() => "key", failed).generate(model, {
      prompt: "test",
      resolution: "1K",
      aspectRatio: "1:1",
    })).rejects.toMatchObject({ message: "Model is not activated", statusCode: 400 });
  });

  it.each([
    [401, "Volcengine Ark credentials were rejected", 503],
    [429, "Volcengine Ark image generation is temporarily rate limited", 429],
    [500, "unavailable", 502],
  ])("maps an HTTP %s response to a useful error", async (status, message, statusCode) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: status === 500 ? "unavailable" : "ignored" } }, { status }));
    const model = seedreamModel("doubao-seedream-5-0-pro-260628")!;
    await expect(new SeedreamProvider(() => "key", request).generate(model, {
      prompt: "test",
      resolution: "1K",
      aspectRatio: "1:1",
    })).rejects.toMatchObject({ message, statusCode });
  });
});
