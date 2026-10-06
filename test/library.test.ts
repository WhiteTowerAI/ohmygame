import { describe, expect, it } from "vitest";
import { filterLibraryAssets } from "../src/renderer/library.js";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
import { libraryAssetProjects } from "../src/renderer/library-assets.js";

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

  it("combines source, project, media, and search filters without changing provenance", () => {
    const projects = [{ id: "forest", name: "Forest", type: "web-game" as const }, { id: "city", name: "City", type: "web-game" as const }];
    const assets: LibraryAsset[] = [
      { ...ASSETS[0]!, origin: "generated", projects },
      { ...ASSETS[1]!, origin: "uploaded", projects: [projects[0]!] },
      { ...ASSETS[2]!, origin: "generated", projects: [projects[1]!] },
    ];
    expect(filterLibraryAssets(assets, "image", "FOREST", { origin: "generated", projectId: "forest" })).toEqual([assets[0]]);
    expect(filterLibraryAssets(assets, "all", "", { origin: "generated", projectId: "city" })).toEqual([assets[0], assets[2]]);
    expect(filterLibraryAssets(assets, "all", "", { origin: "uploaded", projectId: "city" })).toEqual([]);
    expect(libraryAssetProjects(assets)).toEqual([projects[1], projects[0]]);
  });

  it("hides reference inputs by default but includes references used as assets", () => {
    const reference = { ...ASSETS[0]!, purpose: "reference" as const, referenceOnly: true };
    const usedReference = { ...ASSETS[2]!, purpose: "reference" as const, referenceOnly: false };
    expect(filterLibraryAssets([reference, usedReference], "all", "")).toEqual([usedReference]);
    expect(filterLibraryAssets([reference, usedReference], "all", "", { includeReferences: true })).toEqual([reference, usedReference]);
  });

  it("keeps unclassified assets in Library and filters unassigned assets", () => {
    expect(filterLibraryAssets(ASSETS, "all", "", { origin: "unknown", projectId: "unassigned" })).toEqual(ASSETS);
  });

  it("hides historical project copies in Library but keeps them available by source", () => {
    const projectCopy = { ...ASSETS[0]!, origin: "workspace" as const, saved: false };
    const saved = { ...ASSETS[1]!, origin: "workspace" as const, saved: true };
    const generated = { ...ASSETS[2]!, origin: "generated" as const, saved: true };
    const assets = [projectCopy, saved, generated];
    expect(filterLibraryAssets(assets, "all", "")).toEqual([saved, generated]);
    expect(filterLibraryAssets(assets, "all", "", { origin: "workspace" })).toEqual([projectCopy, saved]);
    expect(filterLibraryAssets(assets, "all", "", { origin: "all" })).toEqual(assets);
  });
});
