import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { GameDesignStore, readGameDesign, designReferencesAsset, removeDesignAssetReferences } from "../src/daemon/game-design.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import type { ImageGenerator } from "../src/daemon/openai-image.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGameDesign, designDocumentPath, mergeGameDesign } from "../src/shared/game-design.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import { mergeCanvasDocument } from "../src/shared/design-boards.js";
import { isGameDesign } from "../src/shared/game-design-schema.js";
import type { AssetCanvasNode, ToolRun, RunToolRequest } from "../src/shared/contracts.js";

const directories: string[] = [], stores: GameDesignStore[] = [], apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temp() { const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-design-")); directories.push(directory); return directory; }
const fakeGenerator: ImageGenerator = { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/png" }) };
async function runtime(generator: ImageGenerator = fakeGenerator) {
  const directory = await temp(), library = new AssetLibrary(directory), projects = new ProjectManager(directory, library);
  const tools = new ToolRunner(directory, generator, undefined, undefined, library);
  await Promise.all([library.load(), projects.load(), tools.load()]);
  const project = await projects.create("Sky garden"), store = new GameDesignStore(projects, library, tools);
  stores.push(store);
  const workspace = await store.workspace(project.id), boardId = workspace.boards[0]!.id;
  const detail = await store.board(project.id, boardId), node = createAssetGenerationNode("image", { x: 96, y: 96 });
  if (node.type === "image") node.data.prompt = "A gardener";
  detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
  await store.saveBoard(project.id, detail.board, detail.revision);
  return { directory, library, projects, tools, project, store, boardId, node };
}
async function waitForJob(store: GameDesignStore, projectId: string) {
  await expect.poll(async () => (await store.jobs(projectId))[0]?.status, { timeout: 5000 }).not.toBe("running");
  return (await store.jobs(projectId))[0]!;
}
describe("Markdown design workspace", () => {
  it("starts with one freely named empty board", async () => {
    const { store, projects } = await runtime();
    const other = await projects.create("New game");
    const workspace = await store.workspace(other.id);
    expect(workspace.boards).toHaveLength(1); expect(workspace.documents).toEqual([]);
    expect(workspace.boards[0]!.name).toBe("Untitled");
    expect((await store.board(other.id, workspace.boards[0]!.id)).board.nodes).toEqual([]);
  });
  it("keeps Markdown canonical and rejects stale saves after disk edits", async () => {
    const { store, project } = await runtime();
    const detail = await store.createDocument(project.id, "Rules");
    const updated = await store.save(project.id, { ...detail.document, markdown: "# Rules\n\nPlant seeds." }, detail.revision, detail.document.id);
    const file = path.join(project.workspacePath, designDocumentPath(detail.document.id));
    expect(await readFile(file, "utf8")).toBe(updated.document.markdown);
    await writeFile(file, "# Rules\n\nGrow plants.");
    expect((await readGameDesign(project.workspacePath))!.revision).not.toBe(updated.revision);
    await expect(store.save(project.id, { ...updated.document, title: "Stale" }, updated.revision, detail.document.id)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("shares document references across boards and keeps documents when a board is deleted", async () => {
    const { store, project, boardId } = await runtime();
    const doc = await store.createDocument(project.id, "Rules");
    const index = await store.changeBoards(project.id, { type: "create", name: "Characters" });
    for (const entry of index.boards) {
      const detail = await store.board(project.id, entry.id);
      const node = { id: `doc-${entry.id}`, type: "document" as const, position: { x: 0, y: 0 }, data: { documentId: doc.document.id } };
      detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
      await store.saveBoard(project.id, detail.board, detail.revision);
    }
    await store.changeBoards(project.id, { type: "delete", boardId });
    expect((await store.workspace(project.id)).documents[0]!.id).toBe(doc.document.id);
    await expect(store.changeBoards(project.id, { type: "delete", boardId: index.boards[1]!.id })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("renames, reorders and selects the main document", async () => {
    const { store, project, boardId } = await runtime();
    const index = await store.changeBoards(project.id, { type: "create", name: "Art references" }), secondId = index.boards[1]!.id;
    await store.changeBoards(project.id, { type: "rename", boardId, name: "Mechanics" });
    expect((await store.changeBoards(project.id, { type: "move", boardId: secondId, direction: -1 })).boards.map((board) => board.name)).toEqual(["Art references", "Mechanics"]);
    await store.createDocument(project.id, "First");
    const second = await store.createDocument(project.id, "Second");
    await store.setMainDocument(project.id, second.document.id);
    expect((await store.read(project.id))!.document.id).toBe(second.document.id);
  });
  it("persists layout once and validates document references", async () => {
    const { store, project, boardId } = await runtime();
    const file = JSON.parse(await readFile(path.join(project.workspacePath, `design/boards/${boardId}.json`), "utf8"));
    expect(file.nodes[0]).not.toHaveProperty("position"); expect(file.editorLayout.nodes[file.nodes[0].id]).toEqual({ x: 96, y: 96 });
    const detail = await store.board(project.id, boardId);
    detail.board.nodes.push({ id: "missing", type: "document", position: { x: 0, y: 0 }, data: { documentId: "missing" } }); detail.board.editorLayout.nodes.missing = { x: 0, y: 0 };
    await expect(store.saveBoard(project.id, detail.board, detail.revision)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("copies Library images into the project with Markdown-relative paths", async () => {
    const { store, project, library } = await runtime();
    const doc = await store.createDocument(project.id, "Art"), asset = await library.add("gardener.png", Buffer.from("image"));
    const inserted = await store.insertAsset(project.id, doc.document.id, asset.id);
    expect(inserted.document.markdown).toMatch(/!\[gardener\.png\]\(\.\.\/\.\.\/assets\//);
    const link = inserted.document.markdown.match(/\]\(([^)]+)\)/)![1]!;
    expect(await readFile(path.resolve(project.workspacePath, "design/documents", link), "utf8")).toBe("image");
  });
  it("rejects malformed files and symlinks without overwriting them", async () => {
    const { store, project } = await runtime();
    const doc = await store.createDocument(project.id, "Rules"), file = path.join(project.workspacePath, designDocumentPath(doc.document.id));
    const outside = path.join(await temp(), "outside.md"); await writeFile(outside, "Keep me"); await rm(file); await symlink(outside, file);
    await expect(store.read(project.id)).rejects.toThrow("symbolic links"); expect(await readFile(outside, "utf8")).toBe("Keep me");
    await writeFile(path.join(project.workspacePath, "design/index.json"), "{}");
    await expect(store.workspace(project.id)).rejects.toThrow("Invalid design workspace index");
  });
  it("preserves prompt and position changes while finishing on an inactive board", async () => {
    let finish!: (value: Awaited<ReturnType<ImageGenerator["generate"]>>) => void;
    const { store, project, boardId, node, library } = await runtime({ generate: async () => new Promise((resolve) => { finish = resolve; }) });
    await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Original prompt" });
    await expect.poll(() => Boolean(finish)).toBe(true);
    await store.changeBoards(project.id, { type: "create", name: "Other board" });
    const edited = await store.board(project.id, boardId), image = edited.board.nodes.find((candidate) => candidate.type === "image")!;
    image.data.prompt = "New prompt"; image.position = { x: 480, y: 192 }; edited.board.editorLayout.nodes[image.id] = image.position;
    await store.saveBoard(project.id, edited.board, edited.revision);
    finish({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const job = await waitForJob(store, project.id), saved = (await store.board(project.id, boardId)).board.nodes[0]!;
    expect(job.status).toBe("succeeded"); expect(saved).toMatchObject({ position: image.position, data: { prompt: "New prompt", assetId: job.run!.files[0]!.assetId } });
    expect(library.get(job.run!.files[0]!.assetId!)).toBeDefined();
  });
  it.each(["node", "board"] as const)("keeps output and history when its %s is removed", async (remove) => {
    let finish!: (value: Awaited<ReturnType<ImageGenerator["generate"]>>) => void;
    const { store, project, boardId, node, library } = await runtime({ generate: async () => new Promise((resolve) => { finish = resolve; }) });
    await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" }); await expect.poll(() => Boolean(finish)).toBe(true);
    if (remove === "board") { await store.changeBoards(project.id, { type: "create", name: "Other" }); await store.changeBoards(project.id, { type: "delete", boardId }); }
    else { const board = await store.board(project.id, boardId); board.board.nodes = []; board.board.editorLayout.nodes = {}; await store.saveBoard(project.id, board.board, board.revision); }
    finish({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const job = await waitForJob(store, project.id); expect(job.status).toBe("succeeded"); expect(library.get(job.run!.files[0]!.assetId!)).toBeDefined();
  });
  it("rejects duplicate generation and supports cancellation and retry", async () => {
    let calls = 0;
    const { store, project, boardId, node } = await runtime({ generate: async (_input, signal) => {
      if (calls++) return { bytes: Buffer.from("image"), mediaType: "image/png" };
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
    } });
    const job = await store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" });
    await expect.poll(() => calls).toBe(1);
    await expect(store.start(project.id, boardId, node.id, "generate-image", { prompt: "Garden" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.cancel(project.id, job.id)).status).toBe("cancelled");
    await vi.waitFor(() => expect(calls).toBe(1));
    await store.retry(project.id, job.id); expect((await waitForJob(store, project.id)).status).toBe("succeeded");
  });
  it("restores interrupted jobs as cancelled without another paid call", async () => {
    const { store, project, boardId, node } = await runtime();
    await writeFile(path.join(project.workspacePath, "design/jobs.json"), JSON.stringify([{ id: "interrupted", toolId: "generate-image", context: { projectId: project.id, boardId, nodeId: node.id }, status: "running", createdAt: "now", input: { prompt: "Garden" } }]));
    expect((await store.jobs(project.id))[0]).toMatchObject({ status: "cancelled", error: expect.stringContaining("interrupted") });
  });
  it.each(["generate-video", "image-to-3d", "animate-3d"] as const)("stores %s output in the matching node", async (toolId) => {
    const { store, project, boardId, tools } = await runtime(), board = await store.board(project.id, boardId);
    const node: AssetCanvasNode = toolId === "animate-3d"
      ? { id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: { heightMeters: 1.7, actionIds: [] } }
      : createAssetGenerationNode(toolId === "generate-video" ? "video" : "model-3d", { x: 0, y: 0 });
    board.board.nodes.push(node); board.board.editorLayout.nodes[node.id] = node.position; await store.saveBoard(project.id, board.board, board.revision);
    vi.spyOn(tools, "run").mockResolvedValue({ id: "run", toolId, createdAt: "now", files: [{ name: "output", mediaType: toolId === "generate-video" ? "video/mp4" : "model/gltf-binary", assetId: "output-asset" }] } satisfies ToolRun);
    await store.start(project.id, boardId, node.id, toolId, {} as RunToolRequest);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded"); expect((await store.board(project.id, boardId)).board.nodes.find((candidate) => candidate.id === node.id)!.data).toHaveProperty("assetId", "output-asset");
  });
  it("clears board references when a Library asset is forcibly removed", async () => {
    const { store, project, boardId, node, library } = await runtime(), asset = await library.add("garden.png", Buffer.from("image")), board = await store.board(project.id, boardId);
    const image = board.board.nodes[0]!; if (image.type === "image") { image.data.assetId = asset.id; image.data.images = [{ type: "library", assetId: asset.id }]; }
    await store.saveBoard(project.id, board.board, board.revision); expect(await designReferencesAsset(project.workspacePath, asset.id)).toBe(true);
    await removeDesignAssetReferences(project.workspacePath, asset.id); expect(await designReferencesAsset(project.workspacePath, asset.id)).toBe(false);
    expect((await store.board(project.id, boardId)).board.nodes[0]!.id).toBe(node.id);
  });
  it("protects and clears an animation's Library model reference", async () => {
    const { store, project, boardId, library } = await runtime(), asset = await library.add("character.glb", Buffer.from("model")), board = await store.board(project.id, boardId);
    board.board.nodes.push({ id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: { source: { type: "library", assetId: asset.id }, heightMeters: 1.7, actionIds: [] } });
    board.board.editorLayout.nodes.animation = { x: 0, y: 0 };
    await store.saveBoard(project.id, board.board, board.revision);
    expect(await designReferencesAsset(project.workspacePath, asset.id)).toBe(true);
    await removeDesignAssetReferences(project.workspacePath, asset.id);
    expect(await designReferencesAsset(project.workspacePath, asset.id)).toBe(false);
    expect((await store.board(project.id, boardId)).board.nodes.find((node) => node.id === "animation")!.data).not.toHaveProperty("source");
  });
  it("validates API documents and persists generation through the shared tool route", async () => {
    const app = createApp({ dataDirectory: await temp(), imageGenerator: fakeGenerator }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/design`;
    await expect(lstat(path.join(project.workspacePath, "design"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await app.inject({ method: "POST", url: base, payload: { template: "game" } })).statusCode).toBe(404);
    const workspace = (await app.inject(`${base}/workspace`)).json(), boardId = workspace.boards[0].id;
    expect((await app.inject(`${base}/boards/${boardId}`)).json().board.nodes).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: 42 } })).statusCode).toBe(400);
    const doc = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
    expect(doc.document).toMatchObject({ title: "Rules", markdown: "" });
    expect((await app.inject({ method: "PUT", url: `${base}?documentId=${doc.document.id}`, payload: { ...doc, document: { ...doc.document, markdown: "Changed" } } })).statusCode).toBe(200);
    const detail = (await app.inject(`${base}/boards/${boardId}`)).json(), node = createAssetGenerationNode("image", { x: 0, y: 0 }); detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail })).statusCode).toBe(200);
    const job = await app.inject({ method: "POST", url: `${base}/boards/${boardId}/nodes/${node.id}/generate/generate-image`, payload: { prompt: "Garden" } }); expect(job.statusCode).toBe(202);
    await expect.poll(async () => (await app.inject(`${base}/jobs`)).json()[0]?.status).toBe("succeeded");
  });
  it("generates from a saved document snapshot and rejects stale revisions before calling the model", async () => {
    const model = { provider: "test-provider", id: "test-model" };
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "## Rules\n\nImproved rules" }], stopReason: "stop" });
    const modelRuntime = { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true, completeSimple } as unknown as ModelRuntime;
    const app = createApp({ dataDirectory: await temp(), createModelRuntime: async () => modelRuntime }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/design`;
    const original = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
    const saved = (await app.inject({ method: "PUT", url: `${base}?documentId=${original.document.id}`, payload: { ...original, document: { ...original.document, markdown: "## Rules\n\nCurrent rules" } } })).json();
    const url = `${base}/documents/${saved.document.id}/generate`;
    const payload = { instruction: "Improve the rules", model, revision: saved.revision };
    expect((await app.inject({ method: "POST", url, payload: { ...payload, revision: original.revision } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/documents/missing/generate`, payload })).statusCode).toBe(404);
    expect(completeSimple).not.toHaveBeenCalled();
    const generated = await app.inject({ method: "POST", url, payload });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toEqual({ markdown: "## Rules\n\nImproved rules", model, revision: saved.revision });
    expect(JSON.parse(completeSimple.mock.calls[0]![1].messages[0].content).document).toEqual({ title: "Rules", markdown: saved.document.markdown });
    expect((await app.inject(`${base}?documentId=${saved.document.id}`)).json().design).toEqual(saved);
    completeSimple.mockResolvedValueOnce({ content: [], stopReason: "error" });
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(502);
    expect((await app.inject(`${base}?documentId=${saved.document.id}`)).json().design).toEqual(saved);
  });
});
describe("design merge and validation", () => {
  it("merges independent title/prose edits and reports competing prose edits", () => {
    const base = createGameDesign("Rules");
    expect(mergeGameDesign(base, { ...base, title: "Garden" }, { ...base, markdown: "Plant seeds" })).toMatchObject({ title: "Garden", markdown: "Plant seeds" });
    expect(mergeGameDesign(base, { ...base, markdown: "Left" }, { ...base, markdown: "Right" })).toBeUndefined();
    expect(isGameDesign({ ...base, content: {} })).toBe(false);
  });
  it("merges prompt/layout edits with generated output and preserves node deletions", async () => {
    const { store, project, boardId } = await runtime(), base = (await store.board(project.id, boardId)).board;
    const local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.position = { x: 288, y: 192 }; if (local.nodes[0]!.type === "image") local.nodes[0]!.data.prompt = "New prompt";
    if (remote.nodes[0]!.type === "image") remote.nodes[0]!.data.assetId = "output";
    expect(mergeCanvasDocument(base, local, remote)!.nodes[0]).toMatchObject({ position: { x: 288, y: 192 }, data: { prompt: "New prompt", assetId: "output" } });
    local.nodes = []; local.editorLayout.nodes = {}; expect(mergeCanvasDocument(base, local, remote)!.nodes).toEqual([]);
  });
  it("removes dangling model references and edges while merging independent animation edits", async () => {
    const { store, project, boardId } = await runtime(), base = (await store.board(project.id, boardId)).board;
    const model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    base.nodes = [model, { id: "animation", type: "animate-3d", position: { x: 400, y: 0 }, data: { source: { type: "node", nodeId: model.id }, heightMeters: 1.7, actionIds: [] } }];
    base.editorLayout.nodes = Object.fromEntries(base.nodes.map((node) => [node.id, node.position]));
    base.edges = [{ id: "model-link", source: model.id, target: "animation" }];
    const local = structuredClone(base), remote = structuredClone(base);
    local.nodes = local.nodes.filter((node) => node.id !== model.id);
    if (remote.nodes[1]!.type === "animate-3d") remote.nodes[1]!.data.actionIds = [1];
    const merged = mergeCanvasDocument(base, local, remote)!;
    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0]!.data).toMatchObject({ actionIds: [1] });
    expect(merged.nodes[0]!.data).not.toHaveProperty("source");
    expect(merged.edges).toEqual([]);
  });
});
