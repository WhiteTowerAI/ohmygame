import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { ensureCanvasAssets, readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { MAX_ASSET_CANVAS_NODES } from "../src/shared/asset-canvas-schema.js";
import { canvasImagePresetPrompt } from "../src/shared/canvas-image-presets.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { createPixelAssetWorkflowNodes } from "../src/renderer/asset-canvas-pixel-workflows.js";
import {
  allActionsPrompt,
  characterAssetPrompt,
  continuousActionsPrompt,
} from "../src/shared/canvas-character-tools.js";

const { registerCanvasRoutes } = await import("../src/daemon/canvas-routes.js");

let directory: string;
let app: ReturnType<typeof Fastify>;
let store: ReturnType<typeof registerCanvasRoutes>;
let library: AssetLibrary;
let projects: ProjectManager;
let project: Awaited<ReturnType<ProjectManager["create"]>>;
let assetId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ohmygame-canvas-media-"));
  library = new AssetLibrary(directory);
  projects = new ProjectManager(directory, library);
  await Promise.all([library.load(), projects.load()]);
  project = await projects.create("Media tools", "asset-canvas");
  const tools = new ToolRunner(
    directory,
    {
      generate: async () => {
        throw new Error("Unexpected generation");
      },
    },
    undefined,
    undefined,
    library,
  );
  app = Fastify();
  store = registerCanvasRoutes(app, { projects, library, tools });
  await store.workspace(project.id);
  const bytes = await sharp({
    create: { width: 8, height: 4, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  assetId = (await library.add("source.png", bytes)).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
});

it("saves and reopens a new pixel material workflow with its density group", async () => {
  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const workflow = createPixelAssetWorkflowNodes("tileset", "classic", [], "tileset-workflow");
  const document = createAssetCanvasDocument();
  document.nodes = [
    { id: "pixel-classic", type: "group", position: { x: 0, y: 0 }, width: 600, height: 720, data: { name: "Classic", pixelStyle: "classic" } },
    { id: "tileset-workflow", type: "group", parentId: "pixel-classic", position: { x: 24, y: 48 }, width: 540, height: 650, data: { name: "Terrain · Tileset" } },
    ...workflow.nodes,
  ];
  document.editorLayout.nodes = Object.fromEntries(document.nodes.map((node) => [node.id, {
    ...node.position,
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
  }]));
  const response = await app.inject({
    method: "PUT", url: `/projects/${project.id}/canvas/boards/${boardId}`,
    payload: { board: { ...document, id: boardId }, revision: current.revision },
  });
  expect(response.statusCode, response.body).toBe(200);
  const reopened = await store.board(project.id, boardId);
  expect(reopened.board.nodes).toHaveLength(document.nodes.length);
  expect(reopened.board.nodes.find((node) => node.id === "pixel-classic")).toMatchObject({ type: "group", data: { pixelStyle: "classic" } });
  expect(reopened.board.nodes.find((node) => node.id === workflow.outputNodeId)).toMatchObject({ type: "image", data: { presetId: "tileset", promptExpanded: true } });
});

it.each(["building", "terrain", "tileset"].flatMap((presetId) =>
  (["pixel", "general"] as const).map((materialStyle) => ({ presetId, materialStyle })),
))("saves the $materialStyle $presetId category and passes its prompt to generation", async ({ presetId, materialStyle }) => {
  const workspace = await store.workspace(project.id);
  const boardId = workspace.boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const node = { id: "building", type: "image", position: { x: 0, y: 0 }, data: { prompt: "Castle", presetId, materialStyle, resolution: "1K", aspectRatio: "1:1", images: [] } };
  const response = await app.inject({
    method: "PUT", url: `/projects/${project.id}/canvas/boards/${boardId}`,
    payload: { board: { ...current.board, nodes: [node], editorLayout: { ...current.board.editorLayout, nodes: { building: node.position } } }, revision: current.revision },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((await store.board(project.id, boardId)).board.nodes[0]?.data).toMatchObject({ materialStyle });
  const start = vi.spyOn(store, "start").mockResolvedValue({ id: "style-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Castle" });
  await store.generateNode(project.id, boardId, "building");
  const input = start.mock.calls[0]![4];
  if (!("prompt" in input)) throw new Error("Expected an image generation prompt");
  expect(input.prompt).toContain("Castle");
  if (materialStyle === "pixel") {
    expect(input.prompt).toMatch(/pixel art/i);
    if (presetId === "terrain") expect(input.prompt).toContain("MANDATORY ASSET TYPE: CONTINUOUS TERRAIN");
    if (presetId === "tileset") expect(input.prompt).toContain("MANDATORY ASSET TYPE: TERRAIN TILESET");
  }
  else {
    expect(input.prompt).not.toMatch(/pixel/i);
    expect(input.prompt).toContain("Follow the art style requested");
  }
});

it.each(["coarse", "classic", "detailed"] as const)("preserves %s density across saving, reopening, and generation", async (level) => {
  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const workflow = createPixelAssetWorkflowNodes("tileset", level, [], "nested");
  const output = workflow.nodes[0]!;
  const nodes = [
    { id: "density", type: "group" as const, position: { x: 0, y: 0 }, width: 600, height: 720, data: { name: "Density", pixelStyle: level } },
    { id: "nested", type: "group" as const, parentId: "density", position: { x: 0, y: 0 }, width: 540, height: 650, data: { name: "Nested workflow" } },
    output,
  ];
  const board = { ...current.board, nodes, editorLayout: { ...current.board.editorLayout, nodes: Object.fromEntries(nodes.map((node) => [node.id, { ...node.position, ...(node.width ? { width: node.width } : {}), ...(node.height ? { height: node.height } : {}) }])) } };
  await store.saveBoard(project.id, board, current.revision);
  const reopened = await store.board(project.id, boardId);
  expect(reopened.board.nodes.find((node) => node.id === output.id)).toMatchObject({ data: { pixelStyle: level, promptExpanded: true } });
  const start = vi.spyOn(store, "start").mockResolvedValue({ id: "density-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Tiles" });
  await store.generateNode(project.id, boardId, output.id);
  expect(start.mock.calls.at(-1)![4]).toMatchObject({ prompt: output.type === "image" ? output.data.prompt : "" });

  // An unexpanded older node inherits through nested groups. An explicit node
  // density takes priority over the surrounding group.
  if (output.type !== "image") throw new Error("Expected an image node");
  output.data = { ...output.data, prompt: "Snow tiles", promptExpanded: false };
  delete output.data.pixelStyle;
  const inherited = await store.saveBoard(project.id, board, reopened.revision);
  await store.generateNode(project.id, boardId, output.id);
  expect(start.mock.calls.at(-1)![4]).toMatchObject({ prompt: canvasImagePresetPrompt("tileset", "Snow tiles", undefined, 0, level) });
  const override = level === "detailed" ? "coarse" : "detailed";
  output.data.pixelStyle = override;
  await store.saveBoard(project.id, board, inherited.revision);
  await store.generateNode(project.id, boardId, output.id);
  expect(start.mock.calls.at(-1)![4]).toMatchObject({ prompt: canvasImagePresetPrompt("tileset", "Snow tiles", undefined, 0, override) });
});

it.each(["character-sheet", "consistent-sequence"] as const)("sends an expanded %s prompt exactly as it appears in the image node", async (presetId) => {
  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const prompt = presetId === "consistent-sequence"
    ? canvasImagePresetPrompt(presetId, "A fox explores nine winter scenes")
    : "Create a character sheet with four panels. Render in pixel art.";
  const node = {
    id: "expanded-template-prompt",
    type: "image",
    position: { x: 0, y: 0 },
    data: { prompt, promptExpanded: true, presetId, resolution: "1K", aspectRatio: "16:9", images: [] },
  };
  const board = { ...current.board, nodes: [node], editorLayout: { ...current.board.editorLayout, nodes: { [node.id]: node.position } } };
  const saved = await app.inject({ method: "PUT", url: `/projects/${project.id}/canvas/boards/${boardId}`, payload: { board, revision: current.revision } });
  expect(saved.statusCode, saved.body).toBe(200);

  const start = vi.spyOn(store, "start").mockResolvedValue({ id: "expanded-prompt-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Template prompt" });
  await store.generateNode(project.id, boardId, node.id);
  const input = start.mock.calls[0]![4];
  if (!("prompt" in input)) throw new Error("Expected an image generation prompt");
  expect(input.prompt).toBe(prompt);
});

it.each(["prompt", "legacy field"])("requires a custom action entered through %s before generation", async (mode) => {
  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const workflow = createPixelAssetWorkflowNodes("continuous-sequence", "classic", [], "animation-workflow");
  const node = workflow.nodes.find((candidate) => candidate.id === workflow.outputNodeId);
  if (node?.type !== "image") throw new Error("Missing continuous action node");
  const document = createAssetCanvasDocument();
  document.nodes = [
    { id: "pixel-classic", type: "group", position: { x: 0, y: 0 }, width: 600, height: 720, data: { name: "Classic", pixelStyle: "classic" } },
    { id: "animation-workflow", type: "group", parentId: "pixel-classic", position: { x: 24, y: 48 }, width: 540, height: 650, data: { name: "Animation · Continuous action frames" } },
    ...workflow.nodes,
  ];
  document.editorLayout.nodes = Object.fromEntries(document.nodes.map((entry) => [entry.id, {
    ...entry.position,
    ...(entry.width ? { width: entry.width } : {}),
    ...(entry.height ? { height: entry.height } : {}),
  }]));
  const board = { ...document, id: boardId };
  const saved = await store.saveBoard(project.id, board, current.revision);
  const start = vi.spyOn(store, "start").mockResolvedValue({ id: "action-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Action" });
  await expect(store.generateNode(project.id, boardId, node.id)).rejects.toThrow("Enter an action description");
  expect(start).not.toHaveBeenCalled();
  const action = "raise a shield, brace, then lower it $& $'";
  if (mode === "legacy field") node.data.actionDescription = action;
  else node.data.prompt = node.data.prompt.replace("{USER_ACTION}", () => action);
  await ensureCanvasAssets(project, projects, library, [assetId]);
  node.data.images = [{ type: "library", assetId }];
  await store.saveBoard(project.id, board, saved.revision);
  await store.generateNode(project.id, boardId, node.id);
  const input = start.mock.calls[0]![4];
  expect(input).toMatchObject({ prompt: continuousActionsPrompt(action), images: expect.any(Array) });
});

it("requires one source image for quick reskin and sends it with the appearance prompt", async () => {
  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const node = { id: "reskin", type: "image", position: { x: 0, y: 0 }, data: { prompt: "Red armor", presetId: "quick-reskin", resolution: "1K", aspectRatio: "1:1", images: [] as Array<{ type: "library"; assetId: string }> } };
  const board = { ...current.board, nodes: [node], editorLayout: { ...current.board.editorLayout, nodes: { reskin: node.position } } };
  const saved = await app.inject({ method: "PUT", url: `/projects/${project.id}/canvas/boards/${boardId}`, payload: { board, revision: current.revision } });
  expect(saved.statusCode, saved.body).toBe(200);
  await expect(store.generateNode(project.id, boardId, "reskin")).rejects.toThrow("Quick reskin requires one source image");

  await ensureCanvasAssets(project, projects, library, [assetId]);
  const next = await store.board(project.id, boardId);
  node.data.images = [{ type: "library", assetId }];
  const referenced = await app.inject({ method: "PUT", url: `/projects/${project.id}/canvas/boards/${boardId}`, payload: { board, revision: next.revision } });
  expect(referenced.statusCode, referenced.body).toBe(200);
  const start = vi.spyOn(store, "start").mockResolvedValue({ id: "reskin-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Red armor" });
  await store.generateNode(project.id, boardId, "reskin");
  const input = start.mock.calls[0]![4];
  if (!("prompt" in input) || !("images" in input)) throw new Error("Expected image generation input");
  expect(input.prompt).toContain("same subject, silhouette, pose");
  expect(input.prompt).toContain("Requested appearance changes: Red armor");
  expect(input.images).toHaveLength(1);
});

it("requires person and clothing references for the new quick reskin mode", async () => {
  const clothingBytes = await sharp({
    create: { width: 8, height: 4, channels: 4, background: "blue" },
  }).png().toBuffer();
  const clothingAssetId = (await library.add("clothing.png", clothingBytes)).id;
  await ensureCanvasAssets(project, projects, library, [assetId, clothingAssetId]);

  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  const node = {
    id: "reskin-new",
    type: "image",
    position: { x: 0, y: 0 },
    data: {
      prompt: "Use a red jacket",
      presetId: "quick-reskin",
      quickReskinMode: "person-clothing",
      resolution: "1K",
      aspectRatio: "1:1",
      images: [
        { type: "library" as const, assetId },
        { type: "library" as const, assetId: clothingAssetId },
      ],
    },
  };
  const board = { ...current.board, nodes: [node], editorLayout: { ...current.board.editorLayout, nodes: { [node.id]: node.position } } };
  const saved = await app.inject({ method: "PUT", url: `/projects/${project.id}/canvas/boards/${boardId}`, payload: { board, revision: current.revision } });
  expect(saved.statusCode, saved.body).toBe(200);

  const start = vi.spyOn(store, "start").mockResolvedValue({ id: "reskin-new-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Use a red jacket" });
  await store.generateNode(project.id, boardId, node.id);
  const input = start.mock.calls[0]![4];
  if (!("prompt" in input) || !("images" in input)) throw new Error("Expected image generation input");
  const images = input.images;
  if (!images) throw new Error("Expected quick reskin reference images");
  expect(input.prompt).toContain("first reference image as the person");
  expect(input.prompt).toContain("second reference image as the clothing design");
  expect(input.prompt).toContain("Requested appearance changes: Use a red jacket");
  expect(images).toHaveLength(2);
  expect(Buffer.from(images[0]!.data, "base64")).toEqual(await readFile(path.join(project.workspacePath, (await readCanvasAssets(project.workspacePath)).assets[assetId]!.path)));
  expect(Buffer.from(images[1]!.data, "base64")).toEqual(await readFile(path.join(project.workspacePath, (await readCanvasAssets(project.workspacePath)).assets[clothingAssetId]!.path)));
});

it.each([
  ["character asset", characterAssetPrompt("pixel knight")],
  ["continuous actions", continuousActionsPrompt("walking cycle")],
  ["all actions", allActionsPrompt("idle, attack")],
] as const)(
  "saves a %s image board before generation",
  async (_mode, prompt) => {
    const workspace = await store.workspace(project.id);
    const boardId = workspace.boards[0]!.id;
    const current = await store.board(project.id, boardId);
    const source = {
      id: "source",
      type: "image" as const,
      position: { x: 0, y: 0 },
      data: {
        prompt: "Source",
        resolution: "1K" as const,
        aspectRatio: "1:1" as const,
        images: [],
      },
    };
    const generated = {
      id: "generated",
      type: "image" as const,
      position: { x: 480, y: 0 },
      data: {
        prompt,
        resolution: "1K" as const,
        aspectRatio: "1:1" as const,
        images: [{ type: "node" as const, nodeId: "source" }],
      },
    };
    const board = {
      ...current.board,
      nodes: [source, generated],
      editorLayout: {
        ...current.board.editorLayout,
        nodes: { source: source.position, generated: generated.position },
      },
    };
    const response = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/canvas/boards/${boardId}`,
      payload: { board, revision: current.revision },
    });
    expect(response.statusCode, response.body).toBe(200);
  },
);

it("processes crop-image before the input node has been saved and registers a usable output", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/canvas/media`,
    payload: {
      operation: "crop-image",
      assetIds: [assetId],
      options: { left: 0, top: 0, width: 4, height: 3 },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  expect(result).toMatchObject({ kind: "asset", mediaType: "image" });
  expect(result.assetId).not.toBe(assetId);
  const manifest = await readCanvasAssets(project.workspacePath);
  expect(manifest.assets[result.assetId]).toBeDefined();
  const metadata = await sharp(
    path.join(project.workspacePath, manifest.assets[result.assetId]!.path),
  ).metadata();
  expect(metadata).toMatchObject({ width: 4, height: 3 });
});

it("returns every split frame as a registered canvas asset in frame order", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/canvas/media`,
    payload: {
      operation: "split-image-grid",
      assetIds: [assetId],
      options: { columns: 2, rows: 2 },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  expect(result.kind).toBe("assets");
  expect(result.assets.map((asset: { name: string }) => asset.name)).toEqual([
    "frame-0000.png",
    "frame-0001.png",
    "frame-0002.png",
    "frame-0003.png",
  ]);
  const manifest = await readCanvasAssets(project.workspacePath);
  for (const asset of result.assets) {
    const metadata = await sharp(
      path.join(project.workspacePath, manifest.assets[asset.assetId]!.path),
    ).metadata();
    expect(metadata).toMatchObject({ width: 4, height: 2 });
  }
});

it("creates only the selected cells as canvas nodes", async () => {
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: {
    operation: "split-image-grid", assetIds: [assetId], options: { columns: 2, rows: 2, selectedFrames: [1, 3] },
  } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().assets.map((asset: { name: string }) => asset.name)).toEqual(["frame-0001.png", "frame-0003.png"]);
  const invalid = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: {
    operation: "split-image-grid", assetIds: [assetId], options: { columns: 2, rows: 2, selectedFrames: [] },
  } });
  expect(invalid.statusCode).toBe(400);
});

it("composes selected image assets into one layered PNG", async () => {
  const blue = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
  const blueId = (await library.add("blue.png", blue)).id;
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: {
    operation: "compose-image-layers", assetIds: [assetId, blueId], options: { width: 8, height: 4, layers: [
      { x: 0, y: 0, scale: 1, opacity: 1, visible: true },
      { x: 1, y: 1, scale: 1, opacity: 1, visible: true },
    ] },
  } });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  expect(result).toMatchObject({ kind: "asset", mediaType: "image" });
  const manifest = await readCanvasAssets(project.workspacePath);
  const { data, info } = await sharp(path.join(project.workspacePath, manifest.assets[result.assetId]!.path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 8, height: 4 });
  expect([...data.subarray((1 * 8 + 1) * 4, (1 * 8 + 1) * 4 + 4)]).toEqual([0, 0, 255, 255]);
});

it.each([
  ["compose-video", "video"],
  ["compose-gif", "image"],
] as const)("encodes %s through the canvas route", async (operation, mediaType) => {
  const second = await sharp({ create: { width: 6, height: 6, channels: 4, background: "blue" } }).png().toBuffer();
  const secondId = (await library.add("second.png", second)).id;
  const response = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/canvas/media`,
    payload: { operation, assetIds: [assetId, secondId], options: { fps: 8 } },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  expect(result).toMatchObject({ kind: "asset", mediaType });
  const manifest = await readCanvasAssets(project.workspacePath);
  const saved = path.join(project.workspacePath, manifest.assets[result.assetId]!.path);
  if (operation === "compose-gif") expect((await sharp(saved, { animated: true }).metadata()).pages).toBe(2);
  else expect((await readFile(saved)).toString("ascii", 4, 8)).toBe("ftyp");
});

it("rejects crop-image without dimensions", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/canvas/media`,
    payload: { operation: "crop-image", assetIds: [assetId] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("required");
});

it("reports an incompatible source rather than generating an empty result", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/canvas/media`,
    payload: { operation: "video-frame-strip", assetIds: [assetId] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("requires a video");
});

it("rejects GIF extraction from a regular image", async () => {
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: { operation: "extract-gif-frames", assetIds: [assetId] } });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("GIF extraction requires a GIF asset");
});

it("extracts a GIF asset into image nodes", async () => {
  const gif = await sharp({ create: { width: 8, height: 4, channels: 4, background: "blue" } }).gif().toBuffer();
  const gifId = (await library.add("animation.gif", gif)).id;
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: { operation: "extract-gif-frames", assetIds: [gifId] } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ kind: "assets", assets: [{ mediaType: "image" }] });
});

it("does not register extracted frames when their actual count exceeds board capacity", async () => {
  const gif = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
  const gifId = (await library.add("animation.gif", gif)).id;
  const boardId = (await store.workspace(project.id)).boards[0]!.id;
  const current = await store.board(project.id, boardId);
  vi.spyOn(store, "board").mockResolvedValue({ ...current, board: { ...current.board, nodes: Array(MAX_ASSET_CANVAS_NODES - 1).fill(current.board.nodes[0]) } });
  const before = library.list().length;
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/canvas/media`, payload: { boardId, operation: "extract-gif-frames", assetIds: [gifId] } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe("Canvas is full");
  expect(library.list()).toHaveLength(before);
});
