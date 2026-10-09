import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { CanvasStore, readCanvasDocument, canvasReferencesAsset, removeCanvasAssetReferences } from "../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { checkCanvasWorkspace } from "../src/daemon/canvas-check.js";
import { readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { createAgentTools } from "../src/daemon/agent-tools.js";
import { ImageGenerationError, type ImageGenerator } from "../src/daemon/openai-image.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCanvasDocument, canvasDocumentPath, mergeCanvasDocumentContent } from "../src/shared/canvas-document.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import { fitCanvasLayout, mergeCanvasDocument } from "../src/shared/canvas-workspace.js";
import { isCanvasDocument } from "../src/shared/canvas-document-schema.js";
import type { AssetCanvasNode, ProjectType, ToolRun, RunToolRequest } from "../src/shared/contracts.js";

const directories: string[] = [], stores: CanvasStore[] = [], apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temp() { const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-design-")); directories.push(directory); return directory; }
const fakeGenerator: ImageGenerator = { generate: async () => ({ bytes: Buffer.from("image"), mediaType: "image/png" }) };
async function runtime(generator: ImageGenerator = fakeGenerator, projectType: ProjectType = "web-game", resolveInput?: ConstructorParameters<typeof ToolRunner>[5]) {
  const directory = await temp(), library = new AssetLibrary(directory), projects = new ProjectManager(directory, library);
  const tools = new ToolRunner(directory, generator, undefined, undefined, library, resolveInput);
  await Promise.all([library.load(), projects.load(), tools.load()]);
  const project = await projects.create("Sky garden", projectType), store = new CanvasStore(projects, library, tools);
  stores.push(store);
  const workspace = await store.workspace(project.id), boardId = workspace.boards[0]!.id;
  const detail = await store.board(project.id, boardId), node = createAssetGenerationNode("image", { x: 96, y: 96 });
  if (node.type === "image") node.data.prompt = "A gardener";
  detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
  await store.saveBoard(project.id, detail.board, detail.revision);
  return { directory, library, projects, tools, project, store, boardId, node };
}
async function waitForJob(store: CanvasStore, projectId: string) {
  await expect.poll(async () => (await store.jobs(projectId))[0]?.status, { timeout: 5000 }).not.toBe("running");
  return (await store.jobs(projectId))[0]!;
}
describe("Markdown design workspace", () => {
  it("records contextual defaults in canvas history and preserves them through retries and reloads", async () => {
    let defaultId = "project-image";
    const generate = vi.fn<ImageGenerator["generate"]>()
      .mockRejectedValueOnce(new ImageGenerationError("Temporary service failure", 502))
      .mockResolvedValue({ bytes: Buffer.from("image"), mediaType: "image/png" });
    const resolve = vi.fn(async (_tool: string, input: RunToolRequest, projectId?: string) => ({ ...input, imageModel: "imageModel" in input && input.imageModel ? input.imageModel : { provider: projectId!, id: defaultId } }));
    const { store, project, projects, library, tools, boardId, node } = await runtime({ generate }, "asset-canvas", resolve);
    const first = await store.generateNode(project.id, boardId, node.id);
    expect(first.model).toEqual({ provider: project.id, id: "project-image" });
    expect((await waitForJob(store, project.id)).status).toBe("failed");
    defaultId = "changed-image";
    const restored = new CanvasStore(projects, library, tools); stores.push(restored);
    await restored.retry(project.id, first.id);
    expect((await waitForJob(restored, project.id)).status).toBe("succeeded");
    expect(generate.mock.calls.map(([input]) => input.imageModel)).toEqual([{ provider: project.id, id: "project-image" }, { provider: project.id, id: "project-image" }]);
    const history = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"));
    expect(history[0].model).toEqual({ provider: project.id, id: "project-image" });
    const saved = (await restored.board(project.id, boardId)).board.nodes[0]!;
    expect("model" in saved.data ? saved.data.model : undefined).toBeUndefined();
  });

  it("starts with one freely named empty board", async () => {
    const { store, projects } = await runtime();
    const other = await projects.create("New game");
    const workspace = await store.workspace(other.id);
    expect(workspace.boards).toHaveLength(1); expect(workspace.documents).toEqual([]);
    expect(workspace.boards[0]!.name).toBe("Untitled");
    expect((await store.board(other.id, workspace.boards[0]!.id)).board.nodes).toEqual([]);
  });
  it.each(["managed", "external"])("initializes a %s agent canvas on demand and preserves subsequent edits", async (location) => {
    const { store, projects, tools } = await runtime();
    const project = await projects.create("New game", "web-game", location === "external" ? await temp() : undefined);
    await writeFile(path.join(project.workspacePath, "README.md"), "Existing project notes");
    await expect(lstat(path.join(project.workspacePath, "canvas"))).rejects.toMatchObject({ code: "ENOENT" });
    const initialize = createAgentTools(project, tools, projects, undefined, undefined, undefined, undefined, store)
      .find((tool) => tool.name === "canvas_initialize")!;
    await initialize.execute("initialize", {}, undefined, undefined, {} as never);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    expect(await readFile(path.join(project.workspacePath, "canvas/schemas/board.schema.json"), "utf8")).toContain("documentId");

    const document = await store.createDocument(project.id, "Rules");
    await store.save(project.id, { ...document.document, markdown: "# Keep these rules" }, document.revision, document.document.id);
    const index = await readFile(path.join(project.workspacePath, "canvas/index.json"), "utf8");
    await writeFile(path.join(project.workspacePath, "canvas/AGENTS.md"), "Custom canvas instructions");
    await initialize.execute("initialize-again", {}, undefined, undefined, {} as never);
    expect(await readFile(path.join(project.workspacePath, "canvas/index.json"), "utf8")).toBe(index);
    expect((await store.read(project.id))!.document.markdown).toBe("# Keep these rules");
    expect(await readFile(path.join(project.workspacePath, "canvas/AGENTS.md"), "utf8")).toBe("Custom canvas instructions");
    expect(await readFile(path.join(project.workspacePath, "README.md"), "utf8")).toBe("Existing project notes");
  });
  it.each(["design", "canvas.json"])("requires migration before opening the legacy %s format", async (legacy) => {
    const { store, projects } = await runtime();
    const project = await projects.create("Legacy project");
    const source = path.join(project.workspacePath, legacy);
    if (legacy === "design") await mkdir(source);
    else await writeFile(source, "Legacy canvas data");

    await expect(store.workspace(project.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("migrate-canvas-workspaces.ts") });
    await expect(lstat(path.join(project.workspacePath, "canvas"))).rejects.toMatchObject({ code: "ENOENT" });
    if (legacy === "canvas.json") expect(await readFile(source, "utf8")).toBe("Legacy canvas data");
  });
  it("preserves an incomplete canvas instead of reinitializing its assets", async () => {
    const { store, projects } = await runtime();
    const project = await projects.create("Incomplete canvas");
    const canvas = path.join(project.workspacePath, "canvas");
    await mkdir(canvas);
    const assets = JSON.stringify({ version: 1, assets: { reference: { name: "Reference", path: "assets/reference.png" } } });
    await writeFile(path.join(canvas, "assets.json"), assets);

    await expect(store.workspace(project.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("missing index.json") });
    expect(await readFile(path.join(canvas, "assets.json"), "utf8")).toBe(assets);
    await expect(lstat(path.join(canvas, "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("initializes a complete workspace when generation history is requested first", async () => {
    const { store, projects } = await runtime();
    const project = await projects.create("History before canvas");
    expect(await store.jobs(project.id)).toEqual([]);
    const workspace = await store.workspace(project.id);
    expect(workspace.boards).toHaveLength(1);
    expect((await store.board(project.id, workspace.boards[0]!.id)).board.nodes).toEqual([]);
  });
  it("shares documents and file edits with Asset Canvas while keeping a single board", async () => {
    const { store, project, boardId, library } = await runtime(fakeGenerator, "asset-canvas");
    const doc = await store.createDocument(project.id, "Production reference");
    const updated = await store.save(project.id, { ...doc.document, markdown: "# Brief\n\n一只像素风格的角色。" }, doc.revision, doc.document.id);
    const asset = await library.add("reference.png", Buffer.from("image"));
    const inserted = await store.insertAsset(project.id, doc.document.id, asset.id);
    expect(inserted.document.markdown).toContain(updated.document.markdown);
    expect(inserted.document.markdown).toContain("../../assets/");
    const workspace = await store.workspace(project.id);
    expect(workspace.boards).toHaveLength(1);
    expect(workspace.mainDocumentId).toBeUndefined();
    expect(workspace.documents[0]?.main).toBe(false);
    expect(await store.read(project.id)).toBeUndefined();
    const file = path.join(project.workspacePath, canvasDocumentPath(doc.document.id));
    await writeFile(file, "# Updated production brief");
    expect((await store.read(project.id, doc.document.id))!.document.markdown).toBe("# Updated production brief");
    await expect(store.save(project.id, inserted.document, inserted.revision, doc.document.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.changeBoards(project.id, { type: "create", name: "Second" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.changeBoards(project.id, { type: "delete", boardId })).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.setMainDocument(project.id, doc.document.id)).rejects.toMatchObject({ statusCode: 409 });
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
  });
  it("keeps Markdown canonical and rejects stale saves after disk edits", async () => {
    const { store, project } = await runtime();
    const detail = await store.createDocument(project.id, "Rules");
    const updated = await store.save(project.id, { ...detail.document, markdown: "# Rules\n\nPlant seeds." }, detail.revision, detail.document.id);
    const file = path.join(project.workspacePath, canvasDocumentPath(detail.document.id));
    expect(await readFile(file, "utf8")).toBe(updated.document.markdown);
    await writeFile(file, "# Rules\n\nGrow plants.");
    expect((await readCanvasDocument(project.workspacePath))!.revision).not.toBe(updated.revision);
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
    const file = JSON.parse(await readFile(path.join(project.workspacePath, `canvas/boards/${boardId}.json`), "utf8"));
    expect(file.nodes[0]).not.toHaveProperty("position"); expect(file).not.toHaveProperty("editorLayout");
    const layout = JSON.parse(await readFile(path.join(project.workspacePath, `canvas/editor/${boardId}.json`), "utf8"));
    expect(layout.nodes[file.nodes[0].id]).toEqual({ x: 96, y: 96 });
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
    expect(await readFile(path.resolve(project.workspacePath, "canvas/documents", link), "utf8")).toBe("image");
  });
  it("reads direct semantic edits, fits new nodes and reports malformed fields without rewriting them", async () => {
    const { store, project, boardId, node } = await runtime();
    const filePath = path.join(project.workspacePath, `canvas/boards/${boardId}.json`);
    const content = JSON.parse(await readFile(filePath, "utf8"));
    content.nodes[0].title = "Main character";
    content.nodes[0].description = "Playable gardener sprite";
    content.nodes.push({ id: "rules", type: "text", title: "Rules", data: { text: "Plant seeds", instruction: "" } });
    const text = JSON.stringify(content); await writeFile(filePath, text);
    const detail = await store.board(project.id, boardId);
    expect(detail.board.nodes[0]).toMatchObject({ title: "Main character", description: "Playable gardener sprite", position: node.position });
    expect(detail.board.nodes[1]!.position.x).toBeGreaterThan(node.position.x);
    expect(await readFile(filePath, "utf8")).toBe(text);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    delete content.nodes[0].data.resolution;
    const invalid = JSON.stringify(content); await writeFile(filePath, invalid);
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result).toMatchObject({ ok: false, issues: [{ file: `canvas/boards/${boardId}.json`, message: expect.stringContaining("/nodes/0") }] });
    expect(await readFile(filePath, "utf8")).toBe(invalid);
    await expect(store.board(project.id, boardId)).rejects.toThrow("resolution");
  });
  it.each(["web-game", "asset-canvas"] as const)("lets the %s agent validate and generate a named node from local media and linked Markdown", async (projectType) => {
    const generate = vi.fn(fakeGenerator.generate);
    const { store, project, boardId, node, tools, projects } = await runtime({ generate }, projectType);
    const doc = await store.createDocument(project.id, "Visual direction");
    await store.save(project.id, { ...doc.document, markdown: "A bright garden" }, doc.revision, doc.document.id);
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/reference.png"), "local reference");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { gardener: { name: "Gardener reference", description: "Character direction", path: "assets/reference.png" } } }));
    const detail = await store.board(project.id, boardId), image = detail.board.nodes[0]!;
    if (image.type !== "image") throw new Error("Expected image node");
    image.title = "Gardener sprite"; image.data.prompt = "Pixel art";
    image.data.promptSource = { type: "node", nodeId: "direction" };
    image.data.images = [{ type: "library", assetId: "gardener" }];
    detail.board.nodes.push({ id: "direction", type: "document", position: { x: 0, y: 0 }, data: { documentId: doc.document.id } });
    detail.board.editorLayout.nodes.direction = { x: 0, y: 0 };
    await store.saveBoard(project.id, detail.board, detail.revision);
    expect(generate).not.toHaveBeenCalled();
    const registered = createAgentTools(project, tools, projects, undefined, undefined, undefined, undefined, store);
    const check = await registered.find((tool) => tool.name === "canvas_check")!.execute("check", {}, undefined, undefined, {} as never);
    expect(check.details).toMatchObject({ canvasCheck: { ok: true } });
    const result = await registered.find((tool) => tool.name === "generate_canvas_media")!.execute("generate", { boardId, nodeId: node.id }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ canvasGeneration: { status: "succeeded", context: { boardId, nodeId: node.id } } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ prompt: expect.stringContaining("A bright garden"), images: [{ mediaType: "image/png", data: Buffer.from("local reference").toString("base64") }] });
    expect(generate.mock.calls[0]![0].prompt).toContain("Pixel art");
    const job = (await store.jobs(project.id))[0]!, assetId = job.run!.files[0]!.assetId!;
    const manifest = await readCanvasAssets(project.workspacePath);
    expect(await readFile(path.join(project.workspacePath, manifest.assets[assetId]!.path), "utf8")).toBe("image");
    expect((await store.workspace(project.id)).assets.map((asset) => asset.id)).toContain("gardener");
    expect((await store.board(project.id, boardId)).board.nodes[0]).toMatchObject({ title: "Gardener sprite", data: { assetId } });
    await rm(path.join(project.workspacePath, "assets/reference.png"));
    const broken = await checkCanvasWorkspace(project.workspacePath);
    expect(broken.ok).toBe(false); expect(broken.issues[0]!.file).toContain("/assets/gardener");
  });
  it("exports current file contents and retries video inputs using project asset IDs", async () => {
    const { store, project, boardId, tools, library } = await runtime();
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    const sourcePath = path.join(project.workspacePath, "assets/reference.png");
    await writeFile(sourcePath, "first");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { localImage: { name: "Local reference", path: "assets/reference.png" } } }));
    const first = await store.exportAsset(project.id, "localImage");
    expect(await store.exportAsset(project.id, "localImage")).toEqual(first);
    await writeFile(sourcePath, "updated");
    const updated = await store.exportAsset(project.id, "localImage");
    expect(updated.assetId).not.toBe(first.assetId);
    expect(await readFile((await library.content(updated.assetId)).absolutePath, "utf8")).toBe("updated");
    const detail = await store.board(project.id, boardId), video = createAssetGenerationNode("video", { x: 560, y: 0 });
    if (video.type !== "video") throw new Error("Expected video node");
    video.data.prompt = "Walk"; video.data.references = [{ type: "library", assetId: "localImage" }];
    detail.board.nodes.push(video); detail.board.editorLayout.nodes[video.id] = video.position;
    await store.saveBoard(project.id, detail.board, detail.revision);
    const output = await library.add("walk.mp4", Buffer.from("video"));
    const run = vi.spyOn(tools, "run").mockRejectedValueOnce(new Error("Temporary provider error")).mockResolvedValueOnce({ id: "retry-run", toolId: "generate-video", createdAt: "now", files: [{ name: output.name, mediaType: "video/mp4", assetId: output.id }] });
    const job = await store.generateNode(project.id, boardId, video.id);
    expect((await waitForJob(store, project.id)).status).toBe("failed");
    await store.retry(project.id, job.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(run.mock.calls.map((call) => call[1])).toEqual([expect.objectContaining({ references: [{ type: "image", assetId: updated.assetId }] }), expect.objectContaining({ references: [{ type: "image", assetId: updated.assetId }] })]);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
  });
  it("rejects media mismatches and missing documents with file diagnostics", async () => {
    const { store, project, boardId, library } = await runtime();
    const doc = await store.createDocument(project.id, "Rules"), model = await library.add("reference.glb", Buffer.from("model"));
    const detail = await store.board(project.id, boardId);
    if (detail.board.nodes[0]!.type === "image") detail.board.nodes[0]!.data.images = [{ type: "library", assetId: model.id }];
    await store.saveBoard(project.id, detail.board, detail.revision);
    await rm(path.join(project.workspacePath, canvasDocumentPath(doc.document.id)));
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      { file: canvasDocumentPath(doc.document.id), message: expect.any(String) },
      { file: `canvas/boards/${boardId}.json`, message: expect.stringContaining("unsupported media type") },
    ]));
  });
  it("keeps a missing asset registered without blocking workspace loading or unrelated board saves", async () => {
    const { store, project, boardId } = await runtime();
    const manifest = JSON.stringify({ version: 1, assets: { missing: { name: "Deleted image", path: "assets/deleted.png" } } });
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), manifest);
    const workspace = await store.workspace(project.id);
    expect(workspace.assets).toEqual([]);
    expect(workspace.unavailableAssets).toEqual([{ id: "missing", name: "Deleted image", path: "assets/deleted.png", status: "missing", message: "File not found" }]);
    const board = await store.board(project.id, boardId);
    board.board.nodes[0]!.title = "Still editable";
    await expect(store.saveBoard(project.id, board.board, board.revision)).resolves.toMatchObject({ board: { nodes: [expect.objectContaining({ title: "Still editable" })] } });
    expect(await readFile(path.join(project.workspacePath, "canvas/assets.json"), "utf8")).toBe(manifest);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(false);
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/deleted.png"), "restored");
    const restored = await store.workspace(project.id);
    expect(restored.unavailableAssets).toEqual([]);
    expect(restored.assets).toContainEqual(expect.objectContaining({ id: "missing" }));
  });

  it("allows deleting the last node after its file has been removed externally", async () => {
    const { store, project, boardId } = await runtime();
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    const file = path.join(project.workspacePath, "assets/reference.png");
    await writeFile(file, "reference");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { image: { name: "Reference", path: "assets/reference.png" } } }));
    let board = await store.board(project.id, boardId);
    board.board.nodes.push({ id: "reference", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "image", mediaType: "image" } });
    board.board.editorLayout.nodes.reference = { x: 0, y: 0 };
    await store.saveBoard(project.id, board.board, board.revision);
    await rm(file);
    board = await store.board(project.id, boardId);
    await store.saveBoard(project.id, board.board, board.revision);
    board = await store.board(project.id, boardId);
    board.board.nodes = []; board.board.editorLayout.nodes = {};
    await store.saveBoard(project.id, board.board, board.revision);
    expect((await store.board(project.id, boardId)).board.nodes).toEqual([]);
    expect((await store.workspace(project.id)).unavailableAssets).toHaveLength(1);
  });

  it("preserves existing unregistered references but rejects introducing unknown assets", async () => {
    const { store, project, boardId } = await runtime();
    const file = path.join(project.workspacePath, `canvas/boards/${boardId}.json`);
    const content = JSON.parse(await readFile(file, "utf8"));
    content.nodes[0].data.assetId = "unregistered";
    await writeFile(file, JSON.stringify(content));
    let board = await store.board(project.id, boardId);
    board.board.nodes[0]!.title = "Keep missing output";
    await store.saveBoard(project.id, board.board, board.revision);
    board = await store.board(project.id, boardId);
    if (board.board.nodes[0]!.type === "image") board.board.nodes[0]!.data.images = [{ type: "library", assetId: "new-unknown" }];
    await expect(store.saveBoard(project.id, board.board, board.revision)).rejects.toThrow("new-unknown is not registered");
  });

  it("loads healthy documents and assets when one document file is missing", async () => {
    const { store, project, boardId } = await runtime();
    const missing = await store.createDocument(project.id, "Missing"), healthy = await store.createDocument(project.id, "Healthy");
    await rm(path.join(project.workspacePath, canvasDocumentPath(missing.document.id)));
    const workspace = await store.workspace(project.id);
    expect(workspace.documents.map((document) => document.id)).toEqual([healthy.document.id]);
    expect(workspace.documentIssues).toEqual([expect.objectContaining({ id: missing.document.id, title: "Missing", source: canvasDocumentPath(missing.document.id) })]);
    const board = await store.board(project.id, boardId);
    await store.saveBoard(project.id, board.board, board.revision);
    await writeFile(path.join(project.workspacePath, canvasDocumentPath(missing.document.id)), "Restored document");
    expect((await store.workspace(project.id)).documentIssues).toEqual([]);
  });

  it("inserts a healthy image without validating unrelated missing assets", async () => {
    const { store, project } = await runtime();
    const document = await store.createDocument(project.id, "References");
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/healthy.png"), "healthy");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: {
      healthy: { name: "Healthy", path: "assets/healthy.png" }, missing: { name: "Missing", path: "assets/missing.png" },
    } }));
    expect((await store.insertAsset(project.id, document.document.id, "healthy")).document.markdown).toContain("../../assets/healthy.png");
    await expect(store.insertAsset(project.id, document.document.id, "missing")).rejects.toThrow("File not found");
  });

  it("generates video without requiring unrelated missing assets", async () => {
    const { store, project, boardId, tools, library } = await runtime();
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { missing: { name: "Missing", path: "assets/missing.png" } } }));
    const board = await store.board(project.id, boardId), video = createAssetGenerationNode("video", { x: 560, y: 0 });
    if (video.type !== "video") throw new Error("Expected video node");
    video.data.prompt = "A garden";
    board.board.nodes.push(video); board.board.editorLayout.nodes[video.id] = video.position;
    await store.saveBoard(project.id, board.board, board.revision);
    const output = await library.add("garden.mp4", Buffer.from("video"));
    vi.spyOn(tools, "run").mockResolvedValue({ id: "video-run", toolId: "generate-video", createdAt: "now", files: [{ name: output.name, mediaType: "video/mp4", assetId: output.id }] });
    await store.generateNode(project.id, boardId, video.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
  });
  it("allows named IDs without inheriting object properties and rejects escaping asset paths", async () => {
    const { store, project, boardId } = await runtime();
    const layout = fitCanvasLayout([{ id: "constructor" }, { id: "__proto__" }], { version: 1, nodes: {}, viewport: { x: 0, y: 0, zoom: 1 }, view: "canvas" });
    expect(layout.nodes.constructor).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    expect(layout.nodes.__proto__).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    const detail = await store.board(project.id, boardId);
    if (detail.board.nodes[0]!.type === "image") detail.board.nodes[0]!.data.images = [{ type: "library", assetId: "constructor" }];
    await expect(store.saveBoard(project.id, detail.board, detail.revision)).rejects.toThrow("asset constructor is not registered");
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify({ version: 1, assets: { invalid: { name: "Outside", path: "../outside.png" } } }));
    const result = await checkCanvasWorkspace(project.workspacePath);
    expect(result.ok).toBe(false); expect(result.issues[0]!.message).toContain("/assets/invalid/path");
  });
  it("rejects malformed files and symlinks without overwriting them", async () => {
    const { store, project } = await runtime();
    const doc = await store.createDocument(project.id, "Rules"), file = path.join(project.workspacePath, canvasDocumentPath(doc.document.id));
    const outside = path.join(await temp(), "outside.md"); await writeFile(outside, "Keep me"); await rm(file); await symlink(outside, file);
    await expect(store.read(project.id)).rejects.toThrow("symbolic links"); expect(await readFile(outside, "utf8")).toBe("Keep me");
    await writeFile(path.join(project.workspacePath, "canvas/index.json"), "{}");
    await expect(store.workspace(project.id)).rejects.toThrow("canvas/index.json");
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
    await writeFile(path.join(project.workspacePath, "canvas/jobs.json"), JSON.stringify([{ id: "interrupted", toolId: "generate-image", context: { projectId: project.id, boardId, nodeId: node.id }, status: "running", createdAt: "now", input: { prompt: "Garden" } }]));
    expect((await store.jobs(project.id))[0]).toMatchObject({ status: "cancelled", error: expect.stringContaining("interrupted") });
  });
  it.each(["generate-video", "image-to-3d", "animate-3d"] as const)("stores %s output in the matching node", async (toolId) => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const node: AssetCanvasNode = toolId === "animate-3d"
      ? { id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: { heightMeters: 1.7, actionIds: [] } }
      : createAssetGenerationNode(toolId === "generate-video" ? "video" : "model-3d", { x: 0, y: 0 });
    board.board.nodes.push(node); board.board.editorLayout.nodes[node.id] = node.position; await store.saveBoard(project.id, board.board, board.revision);
    const output = await library.add(toolId === "generate-video" ? "output.mp4" : "output.glb", Buffer.from("output"));
    vi.spyOn(tools, "run").mockResolvedValue({ id: "run", toolId, createdAt: "now", files: [{ name: output.name, mediaType: toolId === "generate-video" ? "video/mp4" : "model/gltf-binary", assetId: output.id }] } satisfies ToolRun);
    await store.start(project.id, boardId, node.id, toolId, {} as RunToolRequest);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded"); expect((await store.board(project.id, boardId)).board.nodes.find((candidate) => candidate.id === node.id)!.data).toHaveProperty("assetId", output.id);
  });
  it("generates animation from a connected 3D node and validates its actual media type", async () => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    const source = await library.add("character.glb", Buffer.from("model"));
    model.data.assetId = source.id;
    const animation: AssetCanvasNode = { id: "animation", type: "animate-3d", position: { x: 400, y: 0 }, data: { source: { type: "node", nodeId: model.id }, heightMeters: 1.7, actionIds: [0] } };
    board.board.nodes.push(model, animation);
    for (const node of [model, animation]) board.board.editorLayout.nodes[node.id] = node.position;
    await store.saveBoard(project.id, board.board, board.revision);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    const output = await library.add("animated.glb", Buffer.from("animated"));
    const run = vi.spyOn(tools, "run").mockResolvedValue({ id: "animation-run", toolId: "animate-3d", createdAt: "now", files: [{ name: output.name, mediaType: "model/gltf-binary", assetId: output.id }] });
    await store.generateNode(project.id, boardId, animation.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    expect(run).toHaveBeenCalledWith("animate-3d", { assetId: source.id, actionIds: [0], heightMeters: 1.7 }, expect.any(AbortSignal));
    const manifest = await readCanvasAssets(project.workspacePath);
    await writeFile(path.join(project.workspacePath, "assets/wrong.png"), "image");
    manifest.assets[source.id]!.path = "assets/wrong.png";
    await writeFile(path.join(project.workspacePath, "canvas/assets.json"), JSON.stringify(manifest));
    const issues = (await checkCanvasWorkspace(project.workspacePath)).issues;
    expect(issues.some((issue) => issue.message.includes(`Node animation: reference ${source.id}`))).toBe(true);
  });
  it("converts saved WebP references to PNG for 3D generation without modifying the asset", async () => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const bytes = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
    const reference = await library.add("reference.webp", bytes), model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected 3D model node");
    model.data.images = [{ type: "library", assetId: reference.id }];
    board.board.nodes.push(model); board.board.editorLayout.nodes[model.id] = model.position;
    await store.saveBoard(project.id, board.board, board.revision);
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    const output = await library.add("character.glb", Buffer.from("model"));
    const run = vi.spyOn(tools, "run").mockResolvedValue({ id: "3d-run", toolId: "image-to-3d", createdAt: "now", files: [{ name: output.name, mediaType: "model/gltf-binary", assetId: output.id }] });
    await store.generateNode(project.id, boardId, model.id);
    expect((await waitForJob(store, project.id)).status).toBe("succeeded");
    const input = run.mock.calls[0]![1];
    if (!("images" in input)) throw new Error("Expected image references");
    expect(run.mock.calls[0]![0]).toBe("image-to-3d");
    expect(input.images![0]!.mediaType).toBe("image/png");
    expect(Buffer.from(input.images![0]!.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const manifest = await readCanvasAssets(project.workspacePath);
    expect(await readFile(path.join(project.workspacePath, manifest.assets[reference.id]!.path))).toEqual(bytes);
  });
  it("rejects an undecodable WebP before starting a provider job", async () => {
    const { store, project, boardId, tools, library } = await runtime(), board = await store.board(project.id, boardId);
    const reference = await library.add("broken.webp", Buffer.from("broken")), model = createAssetGenerationNode("model-3d", { x: 0, y: 0 });
    if (model.type !== "model-3d") throw new Error("Expected 3D model node");
    model.data.images = [{ type: "library", assetId: reference.id }];
    board.board.nodes.push(model); board.board.editorLayout.nodes[model.id] = model.position;
    await store.saveBoard(project.id, board.board, board.revision);
    const run = vi.spyOn(tools, "run");
    await expect(store.generateNode(project.id, boardId, model.id)).rejects.toThrow("Could not convert the WebP");
    expect(run).not.toHaveBeenCalled();
    expect(await store.jobs(project.id)).toEqual([]);
  });
  it("clears board references when a Library asset is forcibly removed", async () => {
    const { store, project, boardId, node, library } = await runtime(), asset = await library.add("garden.png", Buffer.from("image")), board = await store.board(project.id, boardId);
    const image = board.board.nodes[0]!; if (image.type === "image") { image.data.assetId = asset.id; image.data.images = [{ type: "library", assetId: asset.id }]; }
    await store.saveBoard(project.id, board.board, board.revision); expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(true);
    await removeCanvasAssetReferences(project.workspacePath, asset.id); expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(false);
    expect((await store.board(project.id, boardId)).board.nodes[0]!.id).toBe(node.id);
  });
  it("protects and clears an animation's Library model reference", async () => {
    const { store, project, boardId, library } = await runtime(), asset = await library.add("character.glb", Buffer.from("model")), board = await store.board(project.id, boardId);
    board.board.nodes.push({ id: "animation", type: "animate-3d", position: { x: 0, y: 0 }, data: { source: { type: "library", assetId: asset.id }, heightMeters: 1.7, actionIds: [] } });
    board.board.editorLayout.nodes.animation = { x: 0, y: 0 };
    await store.saveBoard(project.id, board.board, board.revision);
    expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(true);
    await removeCanvasAssetReferences(project.workspacePath, asset.id);
    expect(await canvasReferencesAsset(project.workspacePath, asset.id)).toBe(false);
    expect((await store.board(project.id, boardId)).board.nodes.find((node) => node.id === "animation")!.data).not.toHaveProperty("source");
  });
  it("validates API documents and generates from saved node settings and linked Markdown", async () => {
    const generate = vi.fn(fakeGenerator.generate);
    const app = createApp({ dataDirectory: await temp(), imageGenerator: { generate } }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/canvas`;
    await expect(lstat(path.join(project.workspacePath, "canvas"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await app.inject({ method: "POST", url: base, payload: { template: "game" } })).statusCode).toBe(404);
    const workspace = (await app.inject(`${base}/workspace`)).json(), boardId = workspace.boards[0].id;
    expect((await app.inject(`${base}/boards/${boardId}`)).json().board.nodes).toEqual([]);
    expect((await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: 42 } })).statusCode).toBe(400);
    const doc = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
    expect(doc.document).toMatchObject({ title: "Rules", markdown: "" });
    expect((await app.inject({ method: "PUT", url: `${base}?documentId=${doc.document.id}`, payload: { ...doc, document: { ...doc.document, markdown: "Changed" } } })).statusCode).toBe(200);
    const detail = (await app.inject(`${base}/boards/${boardId}`)).json(), node = createAssetGenerationNode("image", { x: 0, y: 0 }); detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.prompt = "Garden"; node.data.resolution = "2K"; node.data.aspectRatio = "16:9";
    node.data.promptSource = { type: "node", nodeId: "brief" };
    detail.board.nodes.push({ id: "brief", type: "document", position: { x: 600, y: 0 }, data: { documentId: doc.document.id } });
    detail.board.editorLayout.nodes.brief = { x: 600, y: 0 };
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail })).statusCode).toBe(200);
    const job = await app.inject({ method: "POST", url: `${base}/boards/${boardId}/nodes/${node.id}/generate` }); expect(job.statusCode).toBe(202);
    await expect.poll(async () => (await app.inject(`${base}/jobs`)).json()[0]?.status).toBe("succeeded");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ prompt: "Changed\n\nGarden", resolution: "2K", aspectRatio: "16:9" });
  });
  it("cancels and finishes canvas generation when the application closes", async () => {
    let started!: () => void;
    const generating = new Promise<void>((resolve) => { started = resolve; });
    const generate = vi.fn<ImageGenerator["generate"]>((_input, signal) => new Promise((_resolve, reject) => {
      started();
      signal!.addEventListener("abort", () => reject(new Error("Generation stopped")), { once: true });
    }));
    const app = createApp({ dataDirectory: await temp(), imageGenerator: { generate } });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json(), base = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject(`${base}/workspace`)).json(), boardId = workspace.boards[0].id;
    const detail = (await app.inject(`${base}/boards/${boardId}`)).json();
    const node = createAssetGenerationNode("image", { x: 0, y: 0 });
    if (node.type !== "image") throw new Error("Expected image node");
    node.data.prompt = "Garden";
    detail.board.nodes.push(node); detail.board.editorLayout.nodes[node.id] = node.position;
    await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail });
    await app.inject({ method: "POST", url: `${base}/boards/${boardId}/nodes/${node.id}/generate` });
    await generating;

    await app.close();
    const history = JSON.parse(await readFile(path.join(project.workspacePath, "canvas/jobs.json"), "utf8"));
    expect(history[0]).toMatchObject({ status: "cancelled" });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it.each(["web-game", "asset-canvas"] as const)("generates from a saved %s document snapshot and rejects stale revisions before calling the model", async (type) => {
    const model = { provider: "test-provider", id: "test-model" };
    const response = vi.fn(() => ({ content: [{ type: "text", text: "## Rules\n\nImproved rules" }], stopReason: "stop" }));
    const streamSimple = vi.fn((_model, _context, _options) => ({ async *[Symbol.asyncIterator]() {
      const message = response();
      yield message.stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message };
    } }));
    const modelRuntime = { getModel: () => model, getAvailable: async () => [model], hasConfiguredAuth: () => true, streamSimple } as unknown as ModelRuntime;
    const app = createApp({ dataDirectory: await temp(), createModelRuntime: async () => modelRuntime }); apps.push(app);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { type } })).json(), base = `/projects/${project.id}/canvas`;
    const original = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
    const saved = (await app.inject({ method: "PUT", url: `${base}?documentId=${original.document.id}`, payload: { ...original, document: { ...original.document, markdown: "## Rules\n\nCurrent rules" } } })).json();
    const url = `${base}/documents/${saved.document.id}/generate`;
    const payload = { instruction: "Improve the rules", model, revision: saved.revision };
    expect((await app.inject({ method: "POST", url, payload: { ...payload, revision: original.revision } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/documents/missing/generate`, payload })).statusCode).toBe(404);
    expect(streamSimple).not.toHaveBeenCalled();
    const generated = await app.inject({ method: "POST", url, payload });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toEqual({ status: "complete", markdown: "## Rules\n\nImproved rules", model, revision: saved.revision });
    expect(JSON.parse(streamSimple.mock.calls[0]![1].messages[0].content).document).toEqual({ title: "Rules", markdown: saved.document.markdown });
    expect((await app.inject(`${base}?documentId=${saved.document.id}`)).json()).toEqual(saved);
    response.mockReturnValueOnce({ content: [], stopReason: "error" });
    const empty = await app.inject({ method: "POST", url, payload });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ status: "empty", markdown: "", error: expect.stringContaining("could not generate"), revision: saved.revision });
    response.mockReturnValueOnce({ content: [{ type: "text", text: "Partial rules" }], stopReason: "length" });
    const incomplete = await app.inject({ method: "POST", url, payload });
    expect(incomplete.statusCode).toBe(200);
    expect(incomplete.json()).toMatchObject({ status: "incomplete", markdown: "Partial rules", error: expect.stringContaining("output limit"), revision: saved.revision });
    expect((await app.inject(`${base}?documentId=${saved.document.id}`)).json()).toEqual(saved);
  });
});
describe("design merge and validation", () => {
  it("merges independent node metadata and content edits and detects conflicting names", async () => {
    const { store, project, boardId } = await runtime(), base = (await store.board(project.id, boardId)).board;
    const local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "Gardener"; remote.nodes[0]!.description = "Player character";
    expect(mergeCanvasDocument(base, local, remote)!.nodes[0]).toMatchObject({ title: "Gardener", description: "Player character" });
    remote.nodes[0]!.title = "Enemy";
    expect(mergeCanvasDocument(base, local, remote)).toBeUndefined();
  });
  it("merges independent title/prose edits and reports competing prose edits", () => {
    const base = createCanvasDocument("Rules");
    expect(mergeCanvasDocumentContent(base, { ...base, title: "Garden" }, { ...base, markdown: "Plant seeds" })).toMatchObject({ title: "Garden", markdown: "Plant seeds" });
    expect(mergeCanvasDocumentContent(base, { ...base, markdown: "Left" }, { ...base, markdown: "Right" })).toBeUndefined();
    expect(isCanvasDocument({ ...base, content: {} })).toBe(false);
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
