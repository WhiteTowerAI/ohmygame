import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvasBoard, isCanvasBoard } from "../src/shared/canvas-workspace.js";
import { pixelExampleImageUrl } from "../src/renderer/asset-canvas-pixel-examples.js";

const api = vi.hoisted(() => ({
  createProject: vi.fn().mockResolvedValue({ id: "project-1" }),
  deleteProject: vi.fn().mockResolvedValue(undefined),
  listImageModels: vi.fn().mockResolvedValue([]),
}));
const canvas = vi.hoisted(() => ({
  getCanvasWorkspace: vi.fn().mockResolvedValue({ version: 1, boards: [{ id: "board-1", name: "Untitled" }], documents: [], assets: [] }),
  getCanvasBoard: vi.fn(),
  saveCanvasBoard: vi.fn().mockResolvedValue(undefined),
}));

vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  ...api,
}));
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/canvas-api.js")>()),
  ...canvas,
}));
const { createPixelAssetTemplateProject } = await import("../src/renderer/asset-canvas-template-project.js");

beforeEach(() => {
  vi.clearAllMocks();
  const board = createCanvasBoard(undefined, true);
  canvas.getCanvasWorkspace.mockResolvedValue({ version: 1, boards: [{ id: board.id, name: "Untitled" }], documents: [], assets: [] });
  canvas.getCanvasBoard.mockResolvedValue({ board, revision: "revision-1" });
});

describe("pixel asset template projects", () => {
  it.each(["coarse", "classic", "detailed"] as const)("creates one %s group with a reference and four linked character generators", async (level) => {
    const created = await createPixelAssetTemplateProject("characters", level);
    const [, saved] = canvas.saveCanvasBoard.mock.calls[0] as [string, { board: ReturnType<typeof createCanvasBoard> }, string];
    const nodes = saved.board.nodes as Array<(typeof saved.board.nodes)[number] & { parentId?: string; title?: string }>;
    const pixelGroups = nodes.filter((node) => node.type === "group" && node.data.pixelStyle);
    const expectedPresets = ["character-sheet", "rpg-character", "multi-angle", "portrait"];

    expect(pixelGroups).toHaveLength(1);
    expect(pixelGroups[0]?.type === "group" && pixelGroups[0].data.pixelStyle).toBe(level);
    expect(Object.keys(saved.board.editorLayout.nodes)).toEqual(nodes.map((node) => node.id));
    for (const group of pixelGroups) {
      const children = nodes.filter((node) => node.parentId === group.id);
      expect(children).toHaveLength(5);
      const reference = children.find((node) => node.type === "image" && node.data.sourceInput);
      const generators = children.filter((node): node is Extract<typeof node, { type: "image" }> => node.type === "image" && !node.data.sourceInput);
      expect(reference?.title).toContain("Reference image");
      expect(reference?.parentId).toBe(group.id);
      expect(generators.map((node) => node.data.presetId)).toEqual(expectedPresets);
      expect(generators.every((node) => node.parentId === group.id)).toBe(true);
      expect(generators.every((node) => node.data.images[0]?.type === "node" && node.data.images[0].nodeId === reference?.id)).toBe(true);
      if (group.type !== "group") continue;
      const levelName = group.data.pixelStyle === "coarse" ? "Coarse" : group.data.pixelStyle === "classic" ? "Classic" : "Fine";
      expect(reference?.title).toContain(levelName);
      expect(generators.every((node) => node.title?.includes(levelName))).toBe(true);
    }
    expect(nodes.filter((node) => node.type === "group")).toHaveLength(1);
    expect(nodes.find((node) => node.id === created.nodeId)?.parentId).toBe(pixelGroups[0]?.id);
  });

  it("creates the seven requested category templates with their density-specific workflows", async () => {
    const expectedCounts = new Map([
      ["characters", 5],
      ["creatures", 3],
      ["animation", 9],
      ["scenes", 2],
      ["terrain", 4],
      ["objects", 3],
      ["skins", 3],
    ] as const);

    for (const [category, count] of expectedCounts) {
      await createPixelAssetTemplateProject(category, "classic");
      const [, saved] = canvas.saveCanvasBoard.mock.calls.at(-1) as [string, { board: ReturnType<typeof createCanvasBoard> }, string];
      const introductions = saved.board.nodes.filter((node) => node.type === "text" && node.data.instruction === `pixel-asset-template:${category}`);
      expect(introductions).toHaveLength(1);
      const introduction = introductions[0]!;
      expect(introduction.parentId).toBeUndefined();
      expect(introduction.type === "text" && introduction.data.instruction).toBe(`pixel-asset-template:${category}`);
      expect(introduction.type === "text" && introduction.data.text).toContain("Add a reference and description");
      expect(introduction.type === "text" && introduction.data.text).not.toContain("Coarse");
      expect(introduction.type === "text" && introduction.data.text).not.toContain("assetCanvas.");
      expect(saved.board.editorLayout.nodes[introduction.id]).toMatchObject({ ...introduction.position, width: 760 });
      expect(isCanvasBoard(saved.board)).toBe(true);
      const groups = saved.board.nodes.filter((node): node is Extract<typeof node, { type: "group" }> => node.type === "group" && Boolean(node.data.pixelStyle));
      expect(groups).toHaveLength(1);
      // The guide sits just above the groups, close enough to read as their introduction.
      expect(groups.every((group) => group.position.y - introduction.position.y > 250 && group.position.y - introduction.position.y < 700)).toBe(true);
      if (category === "animation") {
        expect(introduction.type === "text" && introduction.data.text).toContain("trigger it on a hit event");
        expect(introduction.type === "text" && introduction.data.text).toContain("not consecutive animation frames");
        const steps = saved.board.nodes.filter((node) => node.type === "text");
        expect(steps).toHaveLength(3);
        expect(steps.filter((node) => node.id !== introduction.id).every((node) => node.type === "text" && node.data.instruction === "pixel-asset-template-note")).toBe(true);
        expect(new Set(steps.map((node) => node.position.x))).toEqual(new Set([introduction.position.x]));
        expect(steps.map((node) => node.position.y)).toEqual(steps.map((node) => node.position.y).sort((a, b) => a - b));
        const gifGroups = saved.board.nodes.filter((node) => node.type === "group" && !node.data.pixelStyle);
        expect(gifGroups).toHaveLength(1);
        for (const gifGroup of gifGroups) {
          const gifs = saved.board.nodes.filter((node) => node.parentId === gifGroup.id);
          expect(gifs).toHaveLength(7);
          expect(gifs.every((node) => node.type === "image" && node.data.exampleImage?.startsWith("classic/") && node.data.exampleImage.endsWith(".gif") && pixelExampleImageUrl(node.data.exampleImage))).toBe(true);
        }
      }
      for (const group of groups) {
        const children = saved.board.nodes.filter((node) => node.parentId === group.id);
        expect(children).toHaveLength(count);
        expect(children.every((node) => node.type === "image" && pixelExampleImageUrl(node.data.exampleImage))).toBe(true);
        if (category === "skins") {
          const inputs = children.filter((node) => node.type === "image" && node.data.sourceInput);
          const output = children.find((node) => node.type === "image" && !node.data.sourceInput);
          expect(inputs).toHaveLength(2);
          expect(output?.type === "image" ? output.data.images : []).toEqual(inputs.map((node) => ({ type: "node", nodeId: node.id })));
        } else {
          const reference = children.find((node) => node.type === "image" && node.data.sourceInput);
          const generators = children.filter((node) => node.type === "image" && !node.data.sourceInput);
          expect(reference).toBeDefined();
          expect(generators.every((node) => node.type === "image" && node.data.images.some((image) => image.type === "node" && image.nodeId === reference?.id))).toBe(true);
        }
      }
    }
  });

  it("places the reskin flow directly in the chosen density group", async () => {
    const created = await createPixelAssetTemplateProject("skins", "classic");
    const [projectId, saved] = canvas.saveCanvasBoard.mock.calls[0] as [string, { board: ReturnType<typeof createCanvasBoard> }, string];
    const pixelGroups = saved.board.nodes.filter((node) => node.type === "group" && node.data.pixelStyle);
    const groups = pixelGroups.filter((node): node is Extract<typeof node, { type: "group" }> => node.type === "group");

    expect(created).toMatchObject({ projectId: "project-1" });
    expect(api.createProject).toHaveBeenCalledWith({ name: expect.stringContaining("Outfits"), type: "asset-canvas" });
    expect(api.createProject).toHaveBeenCalledWith({ name: "Outfits · Classic Pixels", type: "asset-canvas" });
    expect(projectId).toBe("project-1");
    expect(groups.map((node) => node.data.pixelStyle)).toEqual(["classic"]);
    expect(saved.board.nodes.filter((node) => node.type === "group")).toHaveLength(1);
    expect(saved.board.nodes.filter((node) => node.type === "image")).toHaveLength(3);
    expect(saved.board.editorLayout.fitView).toBe(true);
    for (const group of groups) {
      const children = saved.board.nodes.filter((node) => node.parentId === group.id);
      expect(children).toHaveLength(3);
      expect(children.every((node) => node.type === "image")).toBe(true);
      expect(children.every((node) => node.parentId === group.id)).toBe(true);
    }
    const output = saved.board.nodes.find((node) => node.id === created.nodeId);
    expect(output?.parentId).toBe(groups[0]?.id);
    expect(output?.title).toContain("Classic Pixels");
    expect(output && saved.board.editorLayout.nodes[output.id]).toEqual(output?.position);
  });

  it("deletes the new canvas when initializing its template fails", async () => {
    canvas.getCanvasBoard.mockRejectedValueOnce(new Error("board unavailable"));
    await expect(createPixelAssetTemplateProject("characters", "classic")).rejects.toThrow("board unavailable");
    expect(api.deleteProject).toHaveBeenCalledWith("project-1");
  });
});
