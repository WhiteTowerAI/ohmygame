import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_3D_CONFIG, buildModel3DToolRequest, normalizeModel3DConfig, resolveModel3D } from "../src/shared/generation-config.js";

describe("shared generation config", () => {
  it("uses the supported 3D controls by default", () => {
    expect(DEFAULT_MODEL_3D_CONFIG).toEqual({ targetPolycount: 4_000, texture: true, pbr: false });
  });

  it("normalizes polycount and disables PBR with textures", () => {
    expect(normalizeModel3DConfig({ targetPolycount: 8_000, texture: false, pbr: true })).toEqual({
      targetPolycount: 8_000, texture: false, pbr: false,
    });
    expect(normalizeModel3DConfig({ targetPolycount: 99 })).toEqual(DEFAULT_MODEL_3D_CONFIG);
  });

  it("builds an image-only tool request", () => {
    const image = { mediaType: "image/png" as const, data: "base64" };
    expect(buildModel3DToolRequest({ targetPolycount: 8_000, texture: true, pbr: true }, [image])).toEqual({
      images: [image], targetPolycount: 8_000, texture: true, pbr: true,
    });
  });

  it("keeps the polycount inside the chosen model's range", () => {
    const meshy71 = { provider: "meshy", id: "meshy-7.1" };
    expect(normalizeModel3DConfig({ model: meshy71, targetPolycount: 100_000 })).toMatchObject({ targetPolycount: 100_000 });
    expect(normalizeModel3DConfig({ targetPolycount: 100_000 })).toMatchObject({ targetPolycount: 4_000 });
    expect(normalizeModel3DConfig({ model: meshy71, targetPolycount: 400_000 })).toMatchObject({ targetPolycount: 30_000 });
  });

  it("resolves known 3D models and defaults to the first", () => {
    expect(resolveModel3D(undefined)).toMatchObject({ id: "meshy-t2" });
    expect(resolveModel3D({ provider: "meshy", id: "meshy-7.1" })).toMatchObject({ maxReferenceImages: 4 });
    expect(resolveModel3D({ provider: "meshy", id: "meshy-5" })).toBeUndefined();
    expect(resolveModel3D(null)).toBeUndefined();
  });

  it("carries the selected 3D model into the tool request", () => {
    const image = { mediaType: "image/png" as const, data: "base64" };
    const model = { provider: "meshy", id: "meshy-t2" };
    expect(normalizeModel3DConfig({ model })).toEqual({ ...DEFAULT_MODEL_3D_CONFIG, model });
    expect(buildModel3DToolRequest({ model }, [image])).toEqual({ images: [image], model, ...DEFAULT_MODEL_3D_CONFIG });
  });
});
