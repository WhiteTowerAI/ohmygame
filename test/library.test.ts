import { describe, expect, it } from "vitest";
import { filterLibraryAssets } from "../src/renderer/library.js";
import type { LibraryAsset } from "../src/renderer/library-assets.js";

const ASSETS: LibraryAsset[] = [
  { id: "hero", assetId: "hero", name: "hero.webp", path: "hero.webp", size: 10, mediaType: "image", contentType: "image/webp", createdAt: "2026-08-24T12:00:00Z", prompt: "Ancient forest shrine" },
  { id: "theme", assetId: "theme", name: "theme.mp3", path: "theme.mp3", size: 20, mediaType: "audio", contentType: "audio/mpeg", createdAt: "2026-08-24T12:00:00Z" },
  { id: "car", assetId: "car", name: "car.glb", path: "car.glb", size: 30, mediaType: "model", contentType: "model/gltf-binary", createdAt: "2026-08-23T12:00:00Z" },
];

describe("library filters", () => {
  it("filters by media type", () => {
    expect(filterLibraryAssets(ASSETS, "image", "")).toEqual([ASSETS[0]]);
    expect(filterLibraryAssets(ASSETS, "audio", "")).toEqual([ASSETS[1]]);
  });

  it("searches paths and project names case-insensitively", () => {
    expect(filterLibraryAssets(ASSETS, "all", "HERO")).toEqual([ASSETS[0]]);
    expect(filterLibraryAssets(ASSETS, "all", "SHRINE")).toEqual([ASSETS[0]]);
    expect(filterLibraryAssets(ASSETS, "all", "car")).toEqual([ASSETS[2]]);
  });
});
