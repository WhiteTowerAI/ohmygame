import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_3D_CONFIG, buildModel3DToolRequest, normalizeModel3DConfig } from "../src/shared/generation-config.js";

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
});
