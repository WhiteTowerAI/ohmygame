import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { checkCanvasWorkspace } from "../src/daemon/canvas-check.js";
import { CanvasStore, readCanvasBoard } from "../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { migrateLegacyAudioJob, migrateLegacyAudioNodes } from "../src/shared/audio-legacy.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe("offline canvas migration", () => {
  it("backs up old files, preserves IDs/content/media/layout and is repeatable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-design-migration-")); directories.push(directory);
    const library = new AssetLibrary(directory), projects = new ProjectManager(directory, library);
    await Promise.all([library.load(), projects.load()]);
    const tools = new ToolRunner(directory, { generate: async () => { throw new Error("Unexpected generation"); } }, undefined, undefined, library);
    const store = new CanvasStore(projects, library, tools);
    const project = await projects.create("Existing canvas"), asset = await library.add("reference.png", Buffer.from("reference"));
    const workspace = await store.workspace(project.id), boardId = workspace.boards[0]!.id;
    const old = (await store.board(project.id, boardId)).board;
    old.nodes = [{ id: "reference", type: "asset", position: { x: 320, y: 120 }, data: { assetId: asset.id, mediaType: "image" } }];
    old.editorLayout.nodes = { reference: { x: 320, y: 120 } };
    const boardPath = path.join(project.workspacePath, `canvas/boards/${boardId}.json`), oldText = JSON.stringify({ ...old, nodes: old.nodes.map(({ position: _position, ...node }) => node) });
    await writeFile(boardPath, oldText);
    await writeFile(path.join(project.workspacePath, "canvas/README.md"), "Old generated instructions");
    const early = await projects.create("Early design"), earlyWorkspace = await store.workspace(early.id), earlyId = earlyWorkspace.boards[0]!.id;
    await writeFile(path.join(early.workspacePath, "canvas/index.json"), JSON.stringify({ version: 1, boards: [{ id: earlyId, name: "Plan" }] }));
    await writeFile(path.join(early.workspacePath, `canvas/boards/${earlyId}.json`), JSON.stringify({ version: 1, id: earlyId, nodes: [], viewport: { x: 10, y: 20, zoom: 0.8 } }));
    await writeFile(path.join(early.workspacePath, "canvas/gdd.json"), JSON.stringify({ id: "rules", title: "Rules", content: {} }));
    await writeFile(path.join(early.workspacePath, "canvas/gdd.md"), "# Rules\n\nPlant seeds.");
    const current = await projects.create("File-backed design"), currentWorkspace = await store.workspace(current.id);
    const doc = await store.createDocument(current.id, "Production notes");
    await store.save(current.id, { ...doc.document, markdown: "# Production\n\nKeep this body." }, doc.revision, doc.document.id);
    await writeFile(path.join(current.workspacePath, "canvas/AGENTS.md"), "Read design/index.json. My custom instructions. Run design_check.");
    for (const existing of [project, early, current]) await rename(path.join(existing.workspacePath, "canvas"), path.join(existing.workspacePath, "design"));
    const assetCanvas = await projects.create("Asset references", "asset-canvas");
    await mkdir(path.join(assetCanvas.workspacePath, "editor"), { recursive: true });
    await writeFile(path.join(assetCanvas.workspacePath, "canvas.json"), JSON.stringify({ version: 1, viewport: old.viewport, nodes: [{ id: "reference", type: "asset", data: { assetId: asset.id, mediaType: "image" } }], edges: [] }));
    await writeFile(path.join(assetCanvas.workspacePath, "editor/layout.json"), JSON.stringify(old.editorLayout));
    await writeFile(path.join(assetCanvas.workspacePath, "AGENTS.md"), "My custom instructions. Read canvas.json and editor/layout.json.");
    await store.close();
    const migrate = () => promisify(execFile)(process.execPath, ["--no-env-file", path.resolve("scripts/migrate-canvas-workspaces.ts"), directory]);
    await migrate();
    expect((await store.board(project.id, boardId)).board.nodes[0]).toMatchObject({ id: "reference", position: { x: 320, y: 120 } });
    const assets = (await store.workspace(project.id)).assets;
    expect(await readFile(path.join(project.workspacePath, assets[0]!.path), "utf8")).toBe("reference");
    const backupEntries = await readdir(path.join(directory, "canvas-backups"));
    expect(backupEntries).toHaveLength(4);
    const backup = backupEntries.find((entry) => entry.startsWith(project.id))!;
    expect(await readFile(path.join(directory, "canvas-backups", backup, `design/boards/${boardId}.json`), "utf8")).toBe(oldText);
    expect(await readFile(path.join(project.workspacePath, "canvas/README.md"), "utf8")).toContain("editor/<id>.json");
    expect((await store.read(early.id))!.document).toEqual({ id: "rules", title: "Rules", markdown: "# Rules\n\nPlant seeds." });
    expect((await store.board(early.id, earlyId)).board.editorLayout.viewport).toEqual({ x: 10, y: 20, zoom: 0.8 });
    expect((await checkCanvasWorkspace(project.workspacePath)).ok).toBe(true);
    expect((await checkCanvasWorkspace(early.workspacePath)).ok).toBe(true);
    expect((await store.workspace(current.id)).boards).toEqual(currentWorkspace.boards);
    expect((await store.read(current.id))!.document.markdown).toBe("# Production\n\nKeep this body.");
    expect(await readFile(path.join(current.workspacePath, "canvas/AGENTS.md"), "utf8")).toBe("Read canvas/index.json. My custom instructions. Run canvas_check.");
    const migratedAssetCanvas = await store.workspace(assetCanvas.id);
    expect(migratedAssetCanvas.mainDocumentId).toBeUndefined();
    expect(migratedAssetCanvas.documents).toEqual([]);
    const migratedBoard = (await store.board(assetCanvas.id, migratedAssetCanvas.boards[0]!.id)).board;
    expect(migratedBoard.nodes[0]).toMatchObject({ id: "reference", position: { x: 320, y: 120 } });
    expect(migratedBoard.nodes.filter((node) => node.type === "group" && node.data.pixelStyle)).toHaveLength(0);
    expect((await checkCanvasWorkspace(assetCanvas.workspacePath)).ok).toBe(true);
    expect(await readFile(path.join(assetCanvas.workspacePath, "AGENTS.md"), "utf8")).toContain("My custom instructions. Read canvas/boards/<board-id>.json");
    expect(await readdir(assetCanvas.workspacePath)).not.toContain("canvas.json");
    expect(await readdir(project.workspacePath)).not.toContain("design");
    expect((await migrate()).stdout).toContain("Already current");
    expect(await readdir(path.join(directory, "canvas-backups"))).toHaveLength(4);
  });
});

describe("audio nodes saved before they were merged", () => {
  it("open as audio nodes, are reported by canvas_check, and stay on disk until saved", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-audio-migration-")); directories.push(directory);
    const library = new AssetLibrary(directory), projects = new ProjectManager(directory, library);
    await Promise.all([library.load(), projects.load()]);
    const store = new CanvasStore(projects, library, new ToolRunner(directory, { generate: async () => { throw new Error("Unexpected generation"); } }, undefined, undefined, library));
    const project = await projects.create("Old audio"), boardId = (await store.workspace(project.id)).boards[0]!.id;
    const board = (await store.board(project.id, boardId)).board;
    const boardPath = path.join(project.workspacePath, `canvas/boards/${boardId}.json`);
    const { editorLayout: _layout, ...file } = board;
    const text = JSON.stringify({ ...file, nodes: [
      { id: "line", type: "speech", data: { text: "Welcome", voiceId: "narrator", speed: 0.5 } },
      { id: "rain", type: "sound-effect", data: { prompt: "Rain", negativePrompt: "thunder", durationSeconds: 5, loop: true } },
      { id: "scene", type: "audio-scene", data: { prompt: "Rain behind a voice", durationSeconds: 0.05 } },
    ] });
    await writeFile(boardPath, text);
    const read = await readCanvasBoard(project.workspacePath, boardId);
    expect(read?.board.nodes.map(({ id, type, data }) => ({ id, type, data }))).toEqual([
      { id: "line", type: "audio", data: { prompt: "Welcome", voiceId: "narrator", speed: 0.5 } },
      { id: "rain", type: "audio", data: { prompt: "Rain", durationSeconds: 5, loop: true } },
      { id: "scene", type: "audio", data: { prompt: "Rain behind a voice", durationSeconds: 0.1 } },
    ]);
    const check = await checkCanvasWorkspace(project.workspacePath);
    expect(check.issues.filter((issue) => issue.message.includes("now one audio node")).length).toBe(3);
    expect(await readFile(boardPath, "utf8")).toBe(text);
  });

  it("fold Seed Audio's old instructions into the prompt so older work sounds the same", () => {
    const model = { provider: "volcengine-seed-audio", id: "seed-audio-1.0" };
    const { value, migrated } = migrateLegacyAudioNodes({ nodes: [
      { id: "line", type: "speech", data: { text: "Welcome", model } },
      { id: "theme", type: "music", data: { prompt: "Harbor", model } },
      { id: "tts", type: "speech", data: { text: "Welcome", model: { provider: "volcengine-tts", id: "seed-tts-2.0" } } },
      { id: "scene", type: "audio-scene", data: { prompt: "As written", model } },
      { id: "note", type: "text", data: { text: "Keep" } },
    ] });
    expect(migrated).toEqual(["line", "theme", "tts", "scene"]);
    expect(value.nodes.map((node) => (node.data as { prompt?: string }).prompt)).toEqual([
      "Speak the following text exactly. Welcome",
      "Create instrumental game background music. Do not include vocals, speech, narration, or lyrics. Description: Harbor",
      "Welcome",
      "As written",
      undefined,
    ]);
    expect(value.nodes[4]).toEqual({ id: "note", type: "text", data: { text: "Keep" } });
  });

  it("read per-kind tool jobs and runs as generate-audio with their kind", () => {
    expect(migrateLegacyAudioJob({ id: "j", toolId: "generate-speech", input: { text: "Hi", voiceId: "v" } })).toEqual({ id: "j", toolId: "generate-audio", input: { prompt: "Hi", voiceId: "v", kind: "speech" } });
    expect(migrateLegacyAudioJob({ id: "m", toolId: "generate-music", input: { prompt: "Theme", lyrics: "la" } })).toEqual({ id: "m", toolId: "generate-audio", input: { prompt: "Theme", kind: "music" } });
    const image = { id: "i", toolId: "generate-image", input: { prompt: "Cat" } };
    expect(migrateLegacyAudioJob(image)).toBe(image);
  });
});
