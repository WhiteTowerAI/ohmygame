import { describe, expect, it, vi } from "vitest";
import { listOpenRouterImageModels, listOpenRouterVideoModels } from "../src/daemon/openrouter-media.js";

const source = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", headers: {} };

describe("OpenRouter media catalogs", () => {
  it("maps image capabilities into editor model options", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{
      id: "openai/gpt-image-2.5-flare",
      name: "OpenAI: GPT Image 2.5 Flare",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: {
        resolution: { type: "enum", values: ["1K", "2K"] },
        aspect_ratio: { type: "enum", values: ["1:1", "16:9", "auto"] },
        n: { type: "range", min: 1, max: 3 },
        input_references: { type: "range", min: 0, max: 5 },
      },
    }] }));

    await expect(listOpenRouterImageModels(source, request)).resolves.toEqual([
      expect.objectContaining({
        provider: "openrouter",
        id: "openai/gpt-image-2.5-flare",
        protocol: "openrouter-images",
        maxOutputs: 3,
        maxReferenceImages: 5,
        generationOptions: [
          { resolution: "1K", aspectRatio: "1:1" },
          { resolution: "1K", aspectRatio: "16:9" },
          { resolution: "2K", aspectRatio: "1:1" },
          { resolution: "2K", aspectRatio: "16:9" },
        ],
      }),
    ]);
    expect(request.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/images/models");
  });

  it("maps only video models with usable generation constraints", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      {
        id: "bytedance/seedance-2.0-mini",
        name: "ByteDance: Seedance 2.0 Mini",
        description: "Reference-to-video generation",
        supported_resolutions: ["480p", "720p"],
        supported_aspect_ratios: ["16:9", "9:16"],
        supported_durations: [4, 5, 31],
        supported_frame_images: ["first_frame", "last_frame"],
      },
      { id: "video/edit-only", name: "Edit only", supported_resolutions: null, supported_aspect_ratios: null, supported_durations: null },
    ] }));

    await expect(listOpenRouterVideoModels(source, request)).resolves.toEqual([
      expect.objectContaining({
        provider: "openrouter",
        id: "bytedance/seedance-2.0-mini",
        resolutions: ["480p", "720p"],
        aspectRatios: ["16:9", "9:16"],
        durations: [4, 5],
        maxImageReferences: 9,
        imageReferenceMode: "reference",
      }),
    ]);
    expect(request.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/videos/models");
  });
});
