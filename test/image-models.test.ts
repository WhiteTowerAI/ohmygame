import { describe, expect, it } from "vitest";
import type { ImageModel } from "../src/shared/contracts.js";
import { imageModelsForProvider, preferredImageModelId } from "../src/daemon/image-models.js";

const CATALOG: ImageModel[] = [
  catalogModel("openai/gpt-image-2", "OpenAI: GPT Image 2", ["1:1", "16:9", "9:16"], 16),
  catalogModel("openai/gpt-image-1", "OpenAI: GPT Image 1", ["1:1", "3:2", "2:3"], 16),
  { ...catalogModel("google/gemini-3.1-flash-image", "Google: Nano Banana 2", ["1:1", "16:9"], 14), supportsResolution: true, generationOptions: [
    { resolution: "1K", aspectRatio: "1:1" }, { resolution: "2K", aspectRatio: "1:1" }, { resolution: "1K", aspectRatio: "16:9" },
  ] },
];

describe("image model families", () => {
  it("keeps image models from a provider's model list and drops everything else", () => {
    const models = imageModelsForProvider("openai", "OpenAI", ["gpt-5.5", "text-embedding-3", "gpt-image-2", "gpt-5-image", "gpt-image-2.5-flare", "tts-1"], CATALOG);

    expect(models.map((model) => model.id)).toEqual(["gpt-image-2.5-flare", "gpt-image-2"]);
    expect(models.every((model) => model.protocol === "openai-images" && model.provider === "openai")).toBe(true);
  });

  it("narrows aspect ratios and names from the public catalog", () => {
    const [model] = imageModelsForProvider("openai", "OpenAI", ["gpt-image-2"], CATALOG);

    expect(model).toMatchObject({ name: "GPT Image 2", maxReferenceImages: 16 });
    expect(new Set(model?.generationOptions.map((option) => option.aspectRatio))).toEqual(new Set(["1:1", "16:9", "9:16"]));
    expect(new Set(model?.generationOptions.map((option) => option.resolution))).toEqual(new Set(["1K", "2K", "4K"]));
  });

  it("limits GPT Image 1 to its fixed sizes", () => {
    const [model] = imageModelsForProvider("openai", "OpenAI", ["gpt-image-1-mini"]);

    expect(model?.generationOptions).toEqual([
      { resolution: "1K", aspectRatio: "1:1" },
      { resolution: "1K", aspectRatio: "3:2" },
      { resolution: "1K", aspectRatio: "2:3" },
    ]);
    expect(model?.name).toBe("GPT Image 1 Mini");
  });

  it("serves relay Gemini models with the catalog's resolutions", () => {
    const [model] = imageModelsForProvider("openai", "Relay", ["gemini-3.1-flash-image"], CATALOG);

    expect(model).toMatchObject({ protocol: "gemini-generate-content", name: "Nano Banana 2" });
    expect(new Set(model?.generationOptions.map((option) => option.resolution))).toEqual(new Set(["1K", "2K"]));
  });

  it("prefers GPT Image 2.5 Flare when nothing is requested", () => {
    expect(preferredImageModelId(["gpt-image-1", "gpt-image-2.5-flare"])).toBe("gpt-image-2.5-flare");
    expect(preferredImageModelId(["gpt-4o", "gpt-image-1"])).toBe("gpt-image-1");
    expect(preferredImageModelId(["gpt-4o"])).toBeUndefined();
  });
});

function catalogModel(id: string, name: string, aspectRatios: ImageModel["generationOptions"][number]["aspectRatio"][], maxReferenceImages: number): ImageModel {
  return {
    provider: "openrouter",
    providerName: "OpenRouter",
    id,
    name,
    sizes: ["1024x1024"],
    generationOptions: aspectRatios.map((aspectRatio) => ({ resolution: "1K", aspectRatio })),
    supportsReferenceImage: true,
    maxReferenceImages,
    maxOutputs: 4,
    protocol: "openrouter-images",
    supportsResolution: false,
    supportsAspectRatio: true,
  };
}
