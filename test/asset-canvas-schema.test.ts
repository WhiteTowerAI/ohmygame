import { describe, expect, it } from "vitest";
import { Check, Errors } from "typebox/value";
import { ASSET_CANVAS_SCHEMA } from "../src/shared/asset-canvas-schema.js";

const canvas = (node: object) => ({
  version: 1,
  viewport: { width: 960, height: 640 },
  nodes: [node],
  edges: [],
});

describe("Asset Canvas schema diagnostics", () => {
  it("accepts a persisted Tripo V3.1 node above Meshy's polycount ceiling", () => {
    expect(Check(ASSET_CANVAS_SCHEMA, canvas({ id: "tripo", type: "model-3d", data: {
      model: { provider: "tripo", id: "v3.1-20260211" }, targetPolycount: 1_200_000, texture: true, pbr: true, images: [],
    } }))).toBe(true);
  });

  it.each([
    ["document", "documentId"],
    ["text", "instruction"],
    ["image", "resolution"],
    ["video", "duration"],
    ["model-3d", "targetPolycount"],
    ["animate-3d", "heightMeters"],
    ["asset", "mediaType"],
  ])(
    "reports missing %s fields without unrelated node errors",
    (type, field) => {
      const value = canvas({ id: "node", type, data: {} });
      expect(Check(ASSET_CANVAS_SCHEMA, value)).toBe(false);
      const errors = Errors(ASSET_CANVAS_SCHEMA, value);
      expect(errors.some((error) => error.message.includes(field!))).toBe(true);
      expect(errors.some((error) => error.keyword === "const")).toBe(false);
    },
  );

  it.each([{}, { type: "unknown" }, { type: "image", data: {} }, null])(
    "rejects an invalid node shape: %j",
    (node) => {
      expect(Check(ASSET_CANVAS_SCHEMA, canvas(node as object))).toBe(false);
    },
  );
});
