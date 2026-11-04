import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CanvasBoardDetail, CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import type { AssetCanvasNode, ProjectState, ToolJob } from "../src/shared/contracts.js";
import type { ProjectPluginCanvas } from "../src/shared/plugins.js";

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
  },
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
  await writeFile(path.join(source, "locales/en.json"), JSON.stringify({ name: "Frames", copy: "Copy image", source: "Source image" }));
  await writeFile(path.join(source, "locales/zh-CN.json"), JSON.stringify({ name: "帧工具", copy: "复制图片", source: "源图片" }));
  const payload = { source: { type: "directory", path: source } };
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
  return { app, project, run, plugin };
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
});
