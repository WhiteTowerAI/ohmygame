import { describe, expect, it } from "vitest";
import { filterLibraryAssets, type LibraryAsset } from "../src/renderer/library.js";

const ASSETS: LibraryAsset[] = [
  { projectId: "forest", projectName: "Forest Adventure", projectUpdatedAt: "2026-08-24T12:00:00Z", path: "assets/hero.webp", size: 10, mediaType: "image", prompt: "Ancient forest shrine" },
  { projectId: "forest", projectName: "Forest Adventure", projectUpdatedAt: "2026-08-24T12:00:00Z", path: "assets/theme.mp3", size: 20, mediaType: "audio" },
  { projectId: "runner", projectName: "Neon Runner", projectUpdatedAt: "2026-08-23T12:00:00Z", path: "models/car.glb", size: 30, mediaType: "model" },
];

describe("library filters", () => {
  it("filters by media type", () => {
    expect(filterLibraryAssets(ASSETS, "image", "")).toEqual([ASSETS[0]]);
    expect(filterLibraryAssets(ASSETS, "audio", "")).toEqual([ASSETS[1]]);
  });

  it("searches paths and project names case-insensitively", () => {
    expect(filterLibraryAssets(ASSETS, "all", "HERO")).toEqual([ASSETS[0]]);
    expect(filterLibraryAssets(ASSETS, "all", "SHRINE")).toEqual([ASSETS[0]]);
    expect(filterLibraryAssets(ASSETS, "all", "neon")).toEqual([ASSETS[2]]);
  });
});
