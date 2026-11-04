import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CanvasBoardDetail, CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import type { AssetCanvasNode, ProjectState, ToolJob } from "../src/shared/contracts.js";
import type { ProjectPluginCanvas } from "../src/shared/plugins.js";
import { canvasPresetInGroup, canvasPresetIssue, type CanvasPresetBoard } from "../src/shared/canvas-plugin-nodes.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { canvasBatchCopies, duplicateCanvasSelection } from "../src/renderer/asset-canvas-clipboard.js";
import { canvasChainHasCycle, canvasChainTextStep, staleCanvasNodes } from "../src/shared/canvas-chains.js";
import { canvasNodeLayout } from "../src/shared/canvas-node-layout.js";

const fixtures: { app: ReturnType<typeof createApp>; directories: string[] }[] = [];
afterEach(async () => {
  for (const { app, directories } of fixtures.splice(0)) {
    await app.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

// Two nodes: one copies its image into its output folder, one describes what it got.
const FRAMES = `
import { copyFile } from "node:fs/promises";
import path from "node:path";
export function activate(context) {
  context.registerCommand("copy", async ({ params, inputs, output }) => {
    if (params.escape) return { file: "../outside.png" };
    await copyFile(inputs.source[0].path, path.join(output, "copy.png"));
    return { file: "copy.png" };
  });
  context.registerCommand("describe", async ({ params, inputs }) =>
    ({ text: params.prefix + ": " + inputs.source.map((input) => input.type + "/" + input.contentType).join(", ") + " x" + params.scale }));
}
`;

const MANIFEST = {
  id: "acme/frames", version: "1.0.0", engines: { "ohmygame-api": "^2.3.0" }, displayName: "%name%", description: "Frame tools.",
  entrypoints: { native: "./index.mjs" },
  capabilities: { native: true },
  contributes: {
    canvasNodes: [
      {
        id: "copy", title: "%copy%", description: "Copies an image.",
        inputs: [{ id: "source", title: "%source%", accepts: "image" }],
        params: { scale: { type: "number", title: "Scale", default: 2, minimum: 1, maximum: 8 }, escape: { type: "boolean", title: "Escape" } },
        output: "image", run: { native: "copy" },
      },
      {
        id: "describe", title: "Describe",
        inputs: [{ id: "source", title: "Source", accepts: "image", multiple: true }],
        params: { prefix: { type: "text", title: "Prefix", default: "Seen" }, scale: { type: "select", title: "Scale", options: ["x1", "x2"], default: "x2" } },
        output: "text", run: { native: "describe" },
      },
    ],
    canvasPresets: [{ id: "knight", title: "%knight%", board: "./presets/knight.json" }],
  },
};

// A prompt, its picture, and a copy of the picture: the nodes keep their links, never outputs.
const KNIGHT: CanvasPresetBoard = {
  nodes: [
    { id: "brief", type: "text", position: { x: 0, y: 0 }, data: { text: "A knight", instruction: "" } },
    { id: "art", type: "image", position: { x: 500, y: 0 }, data: { prompt: "", promptSource: { type: "node", nodeId: "brief" }, resolution: "1K", aspectRatio: "1:1", images: [] } },
    { id: "copy", type: "plugin", position: { x: 1000, y: 0 }, data: { node: "acme/frames:copy", params: {}, inputs: { source: [{ type: "node", nodeId: "art" }] } } },
  ],
  edges: [],
};

async function setup() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-canvas-"));
  const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-canvas-source-"));
  const app = createApp({ dataDirectory });
  fixtures.push({ app, directories: [dataDirectory, source] });
  await app.ready();
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true }); await mkdir(path.join(source, "locales"), { recursive: true });
  await writeFile(path.join(source, "index.mjs"), FRAMES);
  await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(source, "locales/en.json"), JSON.stringify({ name: "Frames", copy: "Copy image", source: "Source image", knight: "Knight sheet" }));
  await writeFile(path.join(source, "locales/zh-CN.json"), JSON.stringify({ name: "帧工具", copy: "复制图片", source: "源图片", knight: "骑士设定" }));
  await mkdir(path.join(source, "presets"));
  // A preset holding an output is refused when the package is checked.
  await writeFile(path.join(source, "presets/knight.json"), JSON.stringify({ ...KNIGHT, nodes: KNIGHT.nodes.map((node) => node.id === "art" ? { ...node, data: { ...node.data, assetId: "made" } } : node) }));
  const payload = { source: { type: "directory", path: source } };
  const refused = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
  expect(refused.body).toContain("./presets/knight.json can't hold outputs or Library assets");
  await writeFile(path.join(source, "presets/knight.json"), JSON.stringify(KNIGHT));
  const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
  expect(inspected.statusCode, inspected.body).toBe(200);
  const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
  expect(added.statusCode, added.body).toBe(201);
  expect((await app.inject({ method: "POST", url: "/plugin-store/acme/frames/consent", payload: { allowed: inspected.json().asks } })).statusCode).toBe(204);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Frames", type: "asset-canvas" } })).json<ProjectState>();
  const on = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/frames`, payload: { on: true, version: "1.0.0" } });
  expect(on.statusCode, on.body).toBe(204);
  const base = `/projects/${project.id}/canvas`;
  const workspace = (await app.inject({ method: "GET", url: `${base}/workspace` })).json<CanvasWorkspaceDetail>();
  const boardUrl = `${base}/boards/${workspace.boards[0]!.id}`;
  const uploaded = await app.inject({ method: "POST", url: "/library/assets", payload: { name: "hero", purpose: "reference", image: { data: PNG, mediaType: "image/png" } } });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const image: AssetCanvasNode = { id: "hero", type: "asset", position: { x: 0, y: 0 }, data: { assetId: uploaded.json<{ id: string }>().id, mediaType: "image" } };
  /** Saves these plugin nodes beside the image, generates `id` and waits for its job. */
  const run = async (nodes: AssetCanvasNode[], id: string) => {
    const detail = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    detail.board.nodes = [image, ...nodes];
    detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, node.position]));
    const saved = await app.inject({ method: "PUT", url: boardUrl, payload: detail });
    expect(saved.statusCode, saved.body).toBe(200);
    const started = await app.inject({ method: "POST", url: `${boardUrl}/nodes/${id}/generate` });
    expect(started.statusCode, started.body).toBe(202);
    const jobId = started.json<ToolJob>().id;
    let job: ToolJob | undefined;
    await expect.poll(async () => {
      job = (await app.inject({ method: "GET", url: `${base}/jobs` })).json<ToolJob[]>().find((item) => item.id === jobId);
      return job?.status;
    }, { timeout: 10_000 }).not.toBe("running");
    const node = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>().board.nodes.find((item) => item.id === id);
    return { job: job!, node: node as Extract<AssetCanvasNode, { type: "plugin" }> };
  };
  const plugin = (id: string, node: string, params: Record<string, string | number | boolean>, inputs: Record<string, Array<{ type: "node"; nodeId: string }>>): AssetCanvasNode =>
    ({ id, type: "plugin", position: { x: 300, y: 0 }, data: { node, params, inputs } });
  return { app, project, run, plugin, boardUrl, base, image };
}

describe("plugin canvas nodes", () => {
  it("lists a project's plugin nodes in its language and runs them into the Library or as text", async () => {
    const { app, project, run, plugin } = await setup();
    const listed = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-canvas?locale=zh-CN` })).json<ProjectPluginCanvas>();
    expect(listed.nodes.map((node) => [node.id, node.pluginName, node.title, node.inputs[0]?.title])).toEqual([
      ["acme/frames:copy", "帧工具", "复制图片", "源图片"],
      ["acme/frames:describe", "帧工具", "Describe", "Source"],
    ]);
    expect(listed.nodes[0]!.params).toEqual([
      { key: "scale", type: "number", title: "Scale", default: 2, minimum: 1, maximum: 8 },
      { key: "escape", type: "boolean", title: "Escape" },
    ]);

    const copied = await run([plugin("copy", "acme/frames:copy", { scale: 3 }, { source: [{ type: "node", nodeId: "hero" }] })], "copy");
    expect(copied.job).toMatchObject({ status: "succeeded", toolId: "plugin-node" });
    expect(copied.node.data.assetId).toBeTruthy();
    const assets = (await app.inject({ method: "GET", url: "/library/assets" })).json<Array<{ id: string; origin: string; mediaType: string }>>();
    expect(assets).toContainEqual(expect.objectContaining({ id: copied.node.data.assetId, origin: "generated", mediaType: "image" }));

    // Defaults fill settings the person left alone; a text node's output is text, and it can feed another node.
    const described = await run([plugin("describe", "acme/frames:describe", {}, { source: [{ type: "node", nodeId: "hero" }, { type: "node", nodeId: "hero" }] })], "describe");
    expect(described.job.status).toBe("succeeded");
    expect(described.node.data.text).toBe("Seen: image/image/png, image/image/png xx2");
  });

  it("refuses inputs and settings the node doesn't take, and files outside its output folder", async () => {
    const { run, plugin } = await setup();
    const hero = { source: [{ type: "node" as const, nodeId: "hero" }] };
    expect((await run([plugin("copy", "acme/frames:copy", {}, {})], "copy")).job.error).toBe("Connect something to Source image");
    expect((await run([plugin("copy", "acme/frames:copy", {}, { source: [...hero.source, ...hero.source] })], "copy")).job.error).toBe("Source image takes one image");
    expect((await run([plugin("copy", "acme/frames:copy", { scale: 9 }, hero)], "copy")).job.error).toBe("Scale must be between 1 and 8");
    expect((await run([plugin("copy", "acme/frames:copy", { scale: "big" }, hero)], "copy")).job.error).toBe("Scale must be a number");
    expect((await run([plugin("describe", "acme/frames:describe", { scale: "x3" }, hero)], "describe")).job.error).toBe("Scale must be one of: x1, x2");
    const escaped = await run([plugin("copy", "acme/frames:copy", { escape: true }, hero)], "copy");
    expect(escaped.job.error).toContain("isn't a file it wrote in its output folder");
    expect(escaped.node.data.assetId).toBeUndefined();
    expect((await run([plugin("copy", "acme/missing:copy", {}, hero)], "copy")).job.status).toBe("failed");
  });

  it("offers presets, hands out their nodes, and adds them as one group with new ids", async () => {
    const { app, project } = await setup();
    const listed = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-canvas?locale=zh-CN` })).json<ProjectPluginCanvas>();
    expect(listed.presets).toEqual([{ id: "acme/frames:knight", plugin: "acme/frames", pluginName: "帧工具", title: "骑士设定" }]);
    const fetched = await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-canvas/presets/acme/frames/knight` });
    expect(fetched.json<CanvasPresetBoard>()).toEqual(KNIGHT);
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-canvas/presets/acme/frames/queen` })).statusCode).toBe(404);
    // Turned off in the project, its presets go too.
    await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/frames`, payload: { on: false } });
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-canvas/presets/acme/frames/knight` })).statusCode).toBe(404);

    let id = 0;
    const added = duplicateCanvasSelection(canvasPresetInGroup(KNIGHT, "Knight sheet", "group"), [], { x: 2000, y: 400 }, () => `new-${++id}`);
    const [group, ...nodes] = added.nodes;
    expect(group).toMatchObject({ type: "group", position: { x: 2000, y: 400 }, width: 1496, height: 482, data: { name: "Knight sheet" } });
    expect(nodes.every((node) => node.parentId === group!.id)).toBe(true);
    expect(nodes.map((node) => node.position)).toEqual([{ x: 28, y: 54 }, { x: 528, y: 54 }, { x: 1028, y: 54 }]);
    expect(nodes[2]!.data).toMatchObject({ inputs: { source: [{ type: "node", nodeId: nodes[1]!.id }] } });
    const board = createAssetCanvasDocument();
    board.nodes = added.nodes;
    board.editorLayout.nodes = Object.fromEntries(added.nodes.map((node) => [node.id, node.position]));
    expect(isAssetCanvasDocument(board)).toBe(true);
  });

  it.each([
    ["an asset node", { nodes: [{ id: "a", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "x", mediaType: "image" } }] }, "can't hold asset nodes"],
    ["a document", { nodes: [{ id: "d", type: "document", position: { x: 0, y: 0 }, data: { documentId: "rules" } }] }, "can't hold document nodes"],
    ["a broken link", { nodes: [{ ...KNIGHT.nodes[2]!, data: { node: "acme/frames:copy", params: {}, inputs: { source: [{ type: "node", nodeId: "gone" }] } } }] }, "Node copy"],
    ["too many nodes", { nodes: Array.from({ length: 201 }, (_, index) => ({ ...KNIGHT.nodes[0]!, id: `n${index}` })) }, "has more than 200 nodes"],
    ["other fields", { ...KNIGHT, viewport: {} }, "has fields other than nodes and edges: viewport"],
    ["nothing", { nodes: [] }, "needs at least one node"],
  ])("refuses a preset with %s", (_name, value, message) => {
    expect(canvasPresetIssue(value)).toContain(message);
  });

  it("records what each run read, marks what changed upstream, and regenerates a chain in order", async () => {
    const { app, plugin, boardUrl, base, image } = await setup();
    const hero = { source: [{ type: "node" as const, nodeId: "hero" }] };
    const copy = plugin("copy", "acme/frames:copy", {}, hero);
    const describe = plugin("describe", "acme/frames:describe", {}, { source: [{ type: "node", nodeId: "copy" }] });
    const saved = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    saved.board.nodes = [image, copy, describe];
    saved.board.editorLayout.nodes = Object.fromEntries(saved.board.nodes.map((node) => [node.id, node.position]));
    expect((await app.inject({ method: "PUT", url: boardUrl, payload: saved })).statusCode).toBe(200);
    const jobs = async () => (await app.inject({ method: "GET", url: `${base}/jobs` })).json<ToolJob[]>();
    const board = async () => (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    const latest = (all: ToolJob[]) => Object.fromEntries([...all].reverse().map((job) => [job.context!.nodeId, job.upstream]));
    // A chain starts each node after the one before finishes, so wait for its last run.
    const settle = (count: number) => expect.poll(async () => { const all = await jobs(); return all.length >= count && !all.some((job) => job.status === "running"); }, { timeout: 10_000 }).toBe(true);

    // Start from the image: copy, then describe, each after what it reads.
    const started = await app.inject({ method: "POST", url: `${boardUrl}/nodes/hero/regenerate` });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json<{ nodes: string[] }>().nodes).toEqual(["copy", "describe"]);
    await settle(2);
    let current = (await board()).board;
    const copied = current.nodes.find((node) => node.id === "copy")!.data as { assetId?: string };
    expect(latest(await jobs())).toMatchObject({ copy: { hero: `asset:${image.data.assetId}` }, describe: { copy: `asset:${copied.assetId}` } });
    expect(staleCanvasNodes(current.nodes, latest(await jobs()))).toEqual(new Set());

    // A new picture upstream leaves both out of date, until the chain runs again from the copy.
    const other = await app.inject({ method: "POST", url: "/library/assets", payload: { name: "villain", purpose: "reference", image: { data: PNG, mediaType: "image/png" } } });
    const detail = await board();
    detail.board.nodes = detail.board.nodes.map((node) => node.id === "hero" ? { ...node, data: { ...node.data, assetId: other.json<{ id: string }>().id } } as AssetCanvasNode : node);
    expect((await app.inject({ method: "PUT", url: boardUrl, payload: detail })).statusCode).toBe(200);
    current = (await board()).board;
    expect(staleCanvasNodes(current.nodes, latest(await jobs()))).toEqual(new Set(["copy", "describe"]));
    expect((await app.inject({ method: "POST", url: `${boardUrl}/nodes/copy/regenerate` })).statusCode).toBe(202);
    await settle(4);
    current = (await board()).board;
    expect(staleCanvasNodes(current.nodes, latest(await jobs()))).toEqual(new Set());
    // Pointing describe at another source, with the old one unchanged, leaves it out of date too.
    const rewired = current.nodes.map((node) => node.id === "describe" ? { ...node, data: { ...node.data, inputs: { source: [{ type: "node", nodeId: "hero" }] } } } as AssetCanvasNode : node);
    expect(staleCanvasNodes(rewired, latest(await jobs()))).toEqual(new Set(["describe"]));

    // From the image with nothing changed, the copy still runs again rather than handing back its output.
    const again = (await app.inject({ method: "POST", url: `${boardUrl}/nodes/hero/regenerate` })).json<{ job: ToolJob & { reused?: string } }>().job;
    expect(again).toMatchObject({ context: { nodeId: "copy" } });
    expect(again.reused).toBeUndefined();
    await settle(5);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const count = (await jobs()).length;

    // A failure stops the chain before what reads it.
    const broken = await board();
    broken.board.nodes = broken.board.nodes.map((node) => node.id === "copy" ? { ...node, data: { ...node.data, params: { escape: true } } } as AssetCanvasNode : node);
    expect((await app.inject({ method: "PUT", url: boardUrl, payload: broken })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${boardUrl}/nodes/copy/regenerate` })).statusCode).toBe(202);
    await settle(count + 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = await jobs();
    expect(after[0]).toMatchObject({ status: "failed", context: { nodeId: "copy" } });
    expect(after.length).toBe(count + 1);
  });

  it("copies a chain once per picked image, each in its own group, and runs every copy", async () => {
    const { app, plugin, boardUrl, base, image } = await setup();
    const copy = plugin("copy", "acme/frames:copy", {}, { source: [{ type: "node", nodeId: "hero" }] });
    const describe = plugin("describe", "acme/frames:describe", {}, { source: [{ type: "node", nodeId: "copy" }] });
    const pictures = await Promise.all(["villain", "squire"].map(async (name) => (await app.inject({ method: "POST", url: "/library/assets", payload: { name, purpose: "reference", image: { data: PNG, mediaType: "image/png" } } })).json<{ id: string; name: string }>()));
    let id = 0;
    const { nodes: copies, starts } = canvasBatchCopies([image, copy, describe], "hero", pictures.map((picture) => ({ assetId: picture.id, name: picture.name })), (name) => name, () => `b${++id}`);
    expect(starts).toEqual(["b1", "b5"]);
    const groups = copies.filter((node) => node.type === "group");
    expect(groups.map((node) => node.data)).toEqual([{ name: "villain.png" }, { name: "squire.png" }]);
    expect(groups[1]!.position.y).toBeGreaterThan(groups[0]!.position.y);
    // b1–b3 are the first copy: its image, then copy and describe reading it, without the original's output.
    expect(copies.find((node) => node.id === "b1")).toMatchObject({ type: "asset", parentId: "b4", data: { assetId: pictures[0]!.id, mediaType: "image" } });
    expect(copies.find((node) => node.id === "b3")!.data).toMatchObject({ inputs: { source: [{ type: "node", nodeId: "b2" }] } });

    // An image copied out of a group keeps the pixel density that group gave it.
    const group = { id: "art", type: "group", position: { x: 0, y: 0 }, width: 900, height: 500, data: { name: "Art", pixelStyle: "coarse" } } as AssetCanvasNode;
    const styled = { id: "styled", type: "image", parentId: "art", position: { x: 20, y: 60 }, data: { prompt: "knight", images: [{ type: "node", nodeId: "hero" }] } } as unknown as AssetCanvasNode;
    expect(canvasBatchCopies([image, group, styled], "hero", [{ assetId: pictures[0]!.id, name: "villain" }], (name) => name).nodes.find((node) => node.type === "image")!.data).toMatchObject({ pixelStyle: "coarse" });
    // A Text node a model writes, with something run after it, keeps a chain from starting.
    const caption = { id: "caption", type: "text", position: { x: 500, y: 0 }, data: { text: "old", instruction: "Describe it", references: [{ type: "node", nodeId: "hero" }] } } as unknown as AssetCanvasNode;
    const reader = plugin("reader", "acme/frames:describe", {}, { source: [{ type: "node", nodeId: "caption" }] });
    expect(canvasChainTextStep([image, caption, reader], "hero")?.id).toBe("caption");
    expect(canvasChainTextStep([image, caption], "hero")).toBeUndefined();
    // Two nodes after the image that read each other have no order to run in.
    const first = plugin("first", "acme/frames:describe", {}, { source: [{ type: "node", nodeId: "hero" }, { type: "node", nodeId: "second" }] });
    const second = plugin("second", "acme/frames:describe", {}, { source: [{ type: "node", nodeId: "first" }] });
    expect(canvasChainHasCycle([image, first, second], "hero")).toBe(true);
    expect(canvasChainHasCycle([image, copy, describe], "hero")).toBe(false);

    const saved = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    saved.board.nodes = [image, copy, describe, ...copies];
    saved.board.editorLayout.nodes = Object.fromEntries(saved.board.nodes.map((node) => [node.id, canvasNodeLayout(node)]));
    const put = await app.inject({ method: "PUT", url: boardUrl, payload: saved });
    expect(put.statusCode, put.body).toBe(200);
    for (const start of starts) expect((await app.inject({ method: "POST", url: `${boardUrl}/nodes/${start}/regenerate` })).statusCode).toBe(202);
    const jobs = async () => (await app.inject({ method: "GET", url: `${base}/jobs` })).json<ToolJob[]>();
    await expect.poll(async () => (await jobs()).map((job) => `${job.context!.nodeId} ${job.status} ${job.error ?? ""}`.trim()).sort(), { timeout: 10_000 }).toEqual(["b2 succeeded", "b3 succeeded", "b6 succeeded", "b7 succeeded"]);
    const board = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>().board;
    const described = board.nodes.filter((node) => node.type === "plugin" && node.parentId && (node.data as { node: string }).node === "acme/frames:describe");
    expect(described.map((node) => typeof (node.data as { text?: string }).text)).toEqual(["string", "string"]);
    // The originals didn't run.
    expect(board.nodes.find((node) => node.id === "describe")!.data).not.toHaveProperty("text");
  });
});
