import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_3D_CONFIG, buildModel3DToolRequest, model3DReferenceLimit, normalizeModel3DConfig } from "../src/shared/generation-config.js";

describe("shared generation config", () => {
  it("uses a valid text-generation default", () => {
    expect(normalizeModel3DConfig(DEFAULT_MODEL_3D_CONFIG)).toEqual(DEFAULT_MODEL_3D_CONFIG);
  });

  it("normalizes Meshy T2 to its image-only controls", () => {
    const config = normalizeModel3DConfig({ model: "meshy-t2", source: "text", quality: "ultra", textureResolution: "8K", pose: "t-pose" });
    expect(config).toMatchObject({ model: "meshy-t2", source: "image", targetPolycount: 4_000, textureResolution: "2K", pose: "auto" });
    expect(config.quality).toBeUndefined();
    expect(model3DReferenceLimit(config)).toBe(1);
  });

  it("keeps Meshy 7 prompt and reference settings independent", () => {
    const config = normalizeModel3DConfig({ model: "meshy-7", source: "image", quality: "ultra", texture: false, imageEnhancement: false });
    expect(config).toMatchObject({ model: "meshy-7", source: "image", quality: "ultra", texture: false, imageEnhancement: false });
    expect(model3DReferenceLimit(config)).toBe(4);
  });

  it("builds only the options supported by Meshy T2", () => {
    const image = { mediaType: "image/png" as const, data: "base64" };
    expect(buildModel3DToolRequest({ model: "meshy-t2", source: "text", quality: "ultra" }, { prompt: "ignored", images: [image] })).toEqual({
      model: "meshy-t2",
      targetPolycount: 4_000,
      texture: true,
      textureResolution: "2K",
      pbr: false,
      pose: "auto",
      images: [image],
    });
  });

  it("builds a Meshy 7 prompt request without image-only options", () => {
    expect(buildModel3DToolRequest({ model: "meshy-7", source: "text", quality: "ultra" }, { prompt: "  chest  ", images: [] })).toEqual({
      model: "meshy-7",
      quality: "ultra",
      texture: true,
      textureResolution: "2K",
      pbr: false,
      pose: "auto",
      prompt: "chest",
    });
  });
});
