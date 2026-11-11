import { describe, expect, it } from "vitest";
import { filterLibraryAssets } from "../src/renderer/library.js";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
import { canvasAssetDownloadName, libraryAssetProjects } from "../src/renderer/library-assets.js";
import { inAssetPeriod, sortAssets } from "../src/renderer/asset-sort.js";

const ASSETS: LibraryAsset[] = [
  { id: "hero", assetId: "hero", name: "hero.webp", path: "hero.webp", size: 10, mediaType: "image", contentType: "image/webp", createdAt: "2026-08-24T12:00:00Z", prompt: "Ancient forest shrine" },
  { id: "theme", assetId: "theme", name: "theme.mp3", path: "theme.mp3", size: 20, mediaType: "audio", contentType: "audio/mpeg", createdAt: "2026-08-24T12:00:00Z" },
  { id: "car", assetId: "car", name: "car.glb", path: "car.glb", size: 30, mediaType: "model", contentType: "model/gltf-binary", createdAt: "2026-08-23T12:00:00Z" },
];

describe("canvas download names", () => {
  it.each([
    ["小猫照片", "output.webp", "小猫照片.webp"],
    ["骑士模型", "model.glb", "骑士模型.glb"],
    ["片头", "output.mp4", "片头.mp4"],
    ["脚步声", "output.ogg", "脚步声.ogg"],
    ["FooBar-Cat", "output.webp", "FooBar-Cat.webp"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "output.png", "ABCDEFGHIJKLMNOPQRSTUVWXYZ.png"],
    ["Hero_01@2x^preview", "output.png", "Hero_01@2x^preview.png"],
    [undefined, "Hero_01.PNG", "Hero_01.PNG"],
    ["角色 v1.2", "model.glb", "角色 v1.2.glb"],
    ["角色.GLB", "model.glb", "角色.glb"],
    ["  小猫照片.webp  ", "output.webp", "小猫照片.webp"],
    [undefined, "output.png", "output.png"],
    ["   ", "model.glb", "model.glb"],
    ["../<>:\"/\\|?*\u0000", "output.png", "output.png"],
    ["猫/咪\\照片:正面?", "output.png", "猫咪照片正面.png"],
    [". hidden name. ", "output.png", "hidden name.png"],
    [".\u3000.\u00a0", "output.png", "output.png"],
    [".\u3000小猫\u3000.", "output.png", "小猫.png"],
    ["CON", "model.glb", "_CON.glb"],
    ["lpt1.preview", "output.png", "_lpt1.preview.png"],
    [".glb", "model.glb", "model.glb"],
  ])("uses title %j with original %j as %j", (title, original, expected) => {
    expect(canvasAssetDownloadName(title, original!)).toBe(expected);
  });

  it("uses the content type when the original name has no extension", () => {
    expect(canvasAssetDownloadName("小猫", "output", "image/webp")).toBe("小猫.webp");
    expect(canvasAssetDownloadName("", "", "model/gltf-binary")).toBe("asset.glb");
    expect(canvasAssetDownloadName("", "")).toBe("asset");
  });

  it("removes every ASCII control character while preserving printable title characters", () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      expect(canvasAssetDownloadName(`Hero${String.fromCharCode(code)}_01`, "output.webp"))
        .toBe("Hero_01.webp");
    }
  });

  it("bounds UTF-8 filename length without splitting Unicode or losing the extension", () => {
    const name = canvasAssetDownloadName("小猫🐈".repeat(100), "output.webp");
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name).toMatch(/^(?:小猫🐈)*(?:小猫?)?\.webp$/u);
  });
});

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

describe("asset sorting", () => {
  const dated = [
    { path: "a/hero_10.png", size: 5, createdAt: "2026-10-02T00:00:00Z" },
    { path: "b/hero_2.png", size: 30, modifiedAt: "2026-10-03T00:00:00Z" },
    { path: "c/undated.png", size: 10 },
    { path: "d/Boss.png", size: 30, createdAt: "2026-10-01T00:00:00Z" },
  ];
  const order = (sort: Parameters<typeof sortAssets>[1]) => sortAssets(dated, sort).map((asset) => asset.path.split("/")[0]);

  it("orders by date with undated assets last in both directions", () => {
    expect(order("newest")).toEqual(["b", "a", "d", "c"]);
    expect(order("oldest")).toEqual(["d", "a", "b", "c"]);
  });

  it("orders by size and breaks ties by identity", () => {
    expect(order("largest")).toEqual(["b", "d", "c", "a"]);
    expect(order("smallest")).toEqual(["a", "c", "b", "d"]);
  });

  it("orders by file name, reading numbers as numbers and ignoring case and folders", () => {
    expect(order("name")).toEqual(["d", "b", "a", "c"]);
  });

  it("does not reorder the list it was given", () => {
    const before = [...dated];
    sortAssets(dated, "largest");
    expect(dated).toEqual(before);
  });
});

describe("asset time filter", () => {
  const now = new Date(2026, 10, 9, 15).getTime();
  const at = (date: Date) => ({ path: "a.png", size: 1, createdAt: date.toISOString() });

  it("starts today at local midnight", () => {
    expect(inAssetPeriod(at(new Date(2026, 10, 9, 0, 0)), "today", now)).toBe(true);
    expect(inAssetPeriod(at(new Date(2026, 10, 8, 23, 59)), "today", now)).toBe(false);
  });

  it("counts whole days back from now and treats an unknown date as outside", () => {
    expect(inAssetPeriod(at(new Date(2026, 10, 3, 15)), "week", now)).toBe(true);
    expect(inAssetPeriod(at(new Date(2026, 10, 1, 15)), "week", now)).toBe(false);
    expect(inAssetPeriod(at(new Date(2026, 9, 20, 15)), "month", now)).toBe(true);
    expect(inAssetPeriod({ path: "a.png", size: 1 }, "month", now)).toBe(false);
    expect(inAssetPeriod({ path: "a.png", size: 1 }, "all", now)).toBe(true);
  });

  it("narrows the Library together with its other filters", () => {
    const recent = { ...ASSETS[0]!, createdAt: new Date(now - 1000).toISOString() };
    expect(filterLibraryAssets([recent, ASSETS[1]!], "all", "", { period: "week" }, now)).toEqual([recent]);
  });
});
