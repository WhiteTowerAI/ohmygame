import { describe, expect, it } from "vitest";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { findAssetCanvasCoverSource } from "../src/shared/asset-canvas-cover.js";
import { pixelExampleCoverUrl, pixelExampleImageUrl } from "../src/renderer/asset-canvas-pixel-examples.js";

const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;

describe("Asset Canvas cover", () => {
  it("uses the last generated visual output", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [
      { id: "image", type: "image", position: { x: 0, y: 0 }, data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [], assetId: "image-1" } },
      { id: "video", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", model: TEST_VIDEO_MODEL, resolution: "720p", aspectRatio: "adaptive", duration: 6, references: [], assetId: "video-1" } },
      { id: "model", type: "model-3d", position: { x: 0, y: 0 }, data: { targetPolycount: 4_000, texture: true, pbr: false, images: [], assetId: "model-1" } },
    ];

    expect(findAssetCanvasCoverSource(canvas)).toEqual({ assetId: "video-1", mediaType: "video" });
  });

  it("falls back to the last generator's template example until the board has media", () => {
    const image = (id: string, exampleImage: string, sourceInput?: true) => ({ id, type: "image" as const, position: { x: 0, y: 0 }, data: { prompt: "", resolution: "1K" as const, aspectRatio: "1:1" as const, images: [], exampleImage, ...(sourceInput ? { sourceInput } : {}) } });
    const nodes = [image("monster", "classic/monster"), image("animal", "classic/animal"), image("reference", "reference/creature", true)];
    expect(findAssetCanvasCoverSource({ ...createAssetCanvasDocument(), nodes })).toBeUndefined();
    expect(pixelExampleCoverUrl(nodes)).toBe(pixelExampleImageUrl("classic/animal"));
    expect(pixelExampleCoverUrl([nodes[2]!])).toBe(pixelExampleImageUrl("reference/creature"));
    expect(pixelExampleCoverUrl([])).toBeUndefined();
  });
});
