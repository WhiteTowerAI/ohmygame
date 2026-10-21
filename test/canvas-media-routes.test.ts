import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { registerCanvasRoutes } from "../src/daemon/canvas-routes.js";
import { readCanvasAssets } from "../src/daemon/canvas-assets.js";
import {
  allActionsPrompt,
  characterAssetPrompt,
  continuousActionsPrompt,
} from "../src/shared/canvas-character-tools.js";

let directory: string;
let app: ReturnType<typeof Fastify>;
let store: ReturnType<typeof registerCanvasRoutes>;
let library: AssetLibrary;
let project: Awaited<ReturnType<ProjectManager["create"]>>;
let assetId: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ohmygame-canvas-media-"));
  library = new AssetLibrary(directory);
  const projects = new ProjectManager(directory, library);
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
  await app.close();
  await store.close();
  await rm(directory, { recursive: true, force: true });
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

it.each([
  ["edit-image", { width: 4 }, 4, 2],
  ["transform-image", { rotate: 90 }, 4, 8],
] as const)(
  "processes %s before the input node has been saved and registers a usable output",
  async (operation, options, width, height) => {
    const response = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/canvas/media`,
      payload: { operation, assetIds: [assetId], options },
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
    expect(metadata).toMatchObject({ width, height });
  },
);

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

it("reports an incompatible source rather than generating an empty result", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/canvas/media`,
    payload: { operation: "extract-video-frames", assetIds: [assetId] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("requires a video");
});
