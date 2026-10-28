// @vitest-environment happy-dom
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";

const api = vi.hoisted(() => ({
  listImageModels: vi.fn().mockResolvedValue([]),
  createProject: vi.fn().mockResolvedValue({ id: "project-1" }),
  deleteProject: vi.fn().mockResolvedValue(undefined),
  setProjectCover: vi.fn().mockResolvedValue(undefined),
  uploadLibraryAsset: vi.fn().mockImplementation(async (file: File) => ({ id: file.name.replace(/\.webp$/, "") })),
  deleteLibraryAsset: vi.fn().mockResolvedValue(undefined),
}));

const canvas = vi.hoisted(() => ({
  getCanvasWorkspace: vi.fn().mockResolvedValue({ boards: [{ id: "board-1" }] }),
  getCanvasBoard: vi.fn().mockResolvedValue({ board: { id: "board-1" }, revision: "1" }),
  saveCanvasBoard: vi.fn().mockResolvedValue({}),
  changeCanvasBoard: vi.fn().mockResolvedValue({}),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  ...api,
}));
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/canvas-api.js")>()),
  ...canvas,
}));
const { createAssetCanvasTemplateProject, createEffectLibraryProject } = await import("../src/renderer/asset-canvas-templates.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(new Blob(["sample"]), { status: 200 }))));
});

describe("template project reference", () => {
  const samples = {
    "pixel-art": ["side-view-character", "rpg-character", "portrait", "monster", "animal", "scene", "terrain", "building", "prop", "icon"],
    "character-sheet": ["character-sheet"],
    "quick-reskin": ["quick-reskin"],
    "free-sequence": ["continuous-sequence", "consistent-sequence"],
    "action-set": ["idle", "walk", "run", "attack", "hurt", "down"],
  } as const;

  it.each(Object.entries(samples) as [keyof typeof samples, readonly string[]][])("preloads the matching samples into %s", async (template, expected) => {
    const created = await createAssetCanvasTemplateProject(template);
    expect(created.projectId).toBe("project-1");
    const saved = (canvas.saveCanvasBoard.mock.calls[0]?.[1] as CanvasBoardDetail | undefined)?.board;
    const groups = saved?.nodes.filter((node) => node.type === "group");
    expect(groups).toHaveLength(template === "pixel-art" ? 5 : 1);
    expect(saved?.nodes.filter((node) => node.type !== "text" && node.type !== "group")
      .every((node) => groups?.some((group) => group.id === node.parentId))).toBe(true);
    expect(created.outputNodeIds.map((id) => {
      const node = saved?.nodes.find((candidate) => candidate.id === id);
      return node?.type === "image" ? node.data.assetId : undefined;
    })).toEqual(expected);
    if (template !== "character-sheet") {
      const source = saved?.nodes.find((node) => node.type === "image" && node.data.sourceInput && node.data.assetId === "character-sheet");
      expect(source).toBeDefined();
      for (const id of created.outputNodeIds) {
        const output = saved?.nodes.find((node) => node.id === id);
        expect(output).toMatchObject({ data: { images: expect.arrayContaining([{ type: "node", nodeId: source?.id }]) } });
      }
    }
    if (template === "quick-reskin") {
      expect(saved?.nodes.find((node) => node.type === "image" && node.data.sourceInput && node.data.assetId === "clothing")).toBeDefined();
    }
    const uploaded = api.uploadLibraryAsset.mock.calls.map(([file]) => (file as File).name);
    expect(uploaded).toEqual([...new Set([
      ...(template === "character-sheet" ? [] : ["character-sheet"]),
      ...(template === "quick-reskin" ? ["clothing"] : template === "pixel-art" ? ["rpg-character"] : []),
      ...expected,
    ])].map((sample) => `${sample}.webp`));
  });

  it("removes the new reference if board creation fails", async () => {
    canvas.getCanvasWorkspace.mockRejectedValueOnce(new Error("board unavailable"));
    await expect(createAssetCanvasTemplateProject("pixel-art")).rejects.toThrow("board unavailable");
    expect(api.deleteProject).toHaveBeenCalledWith("project-1");
    expect(api.deleteLibraryAsset).not.toHaveBeenCalled();
    expect(canvas.getCanvasBoard).not.toHaveBeenCalled();
    expect(api.createProject).toHaveBeenCalledOnce();
  });

  it("removes uploaded examples if saving the board fails", async () => {
    canvas.saveCanvasBoard.mockRejectedValueOnce(new Error("save failed"));
    await expect(createAssetCanvasTemplateProject("quick-reskin")).rejects.toThrow("save failed");
    expect(api.deleteProject).toHaveBeenCalledWith("project-1");
    expect(api.deleteLibraryAsset.mock.calls.map(([id]) => id)).toEqual(["character-sheet", "clothing", "quick-reskin"]);
  });

  it("uses the Effect Library cover for a new Effect Library project", async () => {
    await createEffectLibraryProject();

    expect(api.setProjectCover).toHaveBeenCalledWith("project-1", expect.any(Blob));
  });
});
