import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { canvasAssetCatalog, ensureCanvasAssets } from "../src/daemon/canvas-assets.js";
import { canvasPath, writeCanvasFile, writeCanvasJson } from "../src/daemon/canvas-files.js";
import { ensureCanvasContract } from "../src/daemon/canvas-workspace.js";
import { createCanvasBoard, isCanvasBoard, isCanvasIndex, type CanvasBoard, type CanvasWorkspaceIndex } from "../src/shared/canvas-workspace.js";
import { canvasNodeAssetIds } from "../src/shared/canvas-assets.js";
import { checkCanvasWorkspace } from "../src/daemon/canvas-check.js";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: npx tsx scripts/migrate-canvas-workspaces.ts <data-directory>. Stop OhMyGame before migrating.");
const dataDirectory = path.resolve(argument);
const library = new AssetLibrary(dataDirectory), projects = new ProjectManager(dataDirectory, library);
await Promise.all([library.load(), projects.load()]);

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}
async function json(file: string) { return JSON.parse(await readFile(file, "utf8")); }

for (const project of projects.list()) {
  if (project.workspaceAvailable === false) continue;
  const root = project.workspacePath, oldDesign = path.join(root, "design"), oldCanvas = path.join(root, "canvas.json"), destination = path.join(root, "canvas");
  const hasDesign = await exists(oldDesign), hasCanvas = await exists(oldCanvas);
  if (!hasDesign && !hasCanvas) {
    if (await exists(destination)) console.log(`Already current: ${project.name}`);
    continue;
  }
  if (await exists(destination) || (hasDesign && hasCanvas)) throw new Error(`Conflicting canvas sources in ${project.name}; its files were not modified`);
  const boards: CanvasBoard[] = [];
  let index: CanvasWorkspaceIndex;
  let earlyDocument: { id: string; title: string; markdown: string } | undefined;
  if (hasDesign) {
    index = await json(path.join(oldDesign, "index.json"));
    const early = !Array.isArray(index.documents);
    if (early) {
      if (await exists(path.join(oldDesign, "gdd.json"))) {
        const { id, title } = await json(path.join(oldDesign, "gdd.json"));
        earlyDocument = { id, title, markdown: await readFile(path.join(oldDesign, "gdd.md"), "utf8") };
        index.mainDocumentId = id;
      }
      index.documents = earlyDocument ? [{ id: earlyDocument.id, title: earlyDocument.title }] : [];
    }
    if (!isCanvasIndex(index)) throw new Error(`Invalid Design index in ${project.name}`);
    for (const entry of index.boards) {
      const raw = await json(path.join(oldDesign, "boards", `${entry.id}.json`));
      let board: CanvasBoard;
      if (early) {
        if (!Array.isArray(raw.nodes) || raw.nodes.length) throw new Error(`Unsupported early board ${entry.id} in ${project.name}; its files were not modified`);
        board = createCanvasBoard(entry.id);
        board.editorLayout.viewport = raw.viewport;
      } else {
        const editorLayout = raw.editorLayout ?? await json(path.join(oldDesign, "editor", `${entry.id}.json`));
        board = { ...raw, editorLayout, nodes: raw.nodes.map((node: CanvasBoard["nodes"][number]) => ({ ...node, position: editorLayout.nodes[node.id] })) };
      }
      if (!isCanvasBoard(board) || board.id !== entry.id) throw new Error(`Invalid board ${entry.id} in ${project.name}`);
      boards.push(board);
    }
  } else {
    if (project.type !== "asset-canvas") throw new Error(`Unexpected canvas.json in ${project.name}`);
    const raw = await json(oldCanvas), editorLayout = await json(path.join(root, "editor/layout.json"));
    const board = { ...raw, id: randomUUID(), editorLayout, nodes: raw.nodes.map((node: CanvasBoard["nodes"][number]) => ({ ...node, position: editorLayout.nodes[node.id] })) };
    if (!isCanvasBoard(board)) throw new Error(`Invalid Asset Canvas in ${project.name}`);
    boards.push(board);
    index = { version: 1, boards: [{ id: board.id, name: project.name.slice(0, 120) || "Untitled" }], documents: [] };
  }
  // Validate every Library reference before creating or changing project files.
  const manifest = hasDesign && await exists(path.join(oldDesign, "assets.json")) ? await json(path.join(oldDesign, "assets.json")) : undefined;
  for (const id of canvasNodeAssetIds(boards.flatMap((board) => board.nodes))) {
    if (!Object.hasOwn(manifest?.assets ?? {}, id)) await library.content(id);
  }
  const backup = path.join(dataDirectory, "canvas-backups", `${project.id}-${randomUUID()}`);
  await mkdir(backup, { recursive: true });
  if (hasDesign) await cp(oldDesign, path.join(backup, "design"), { recursive: true, errorOnExist: true, force: false });
  else for (const name of ["canvas.json", "editor/layout.json", "schemas/asset-canvas.schema.json", "schemas/editor-layout.schema.json", "AGENTS.md"]) {
    if (await exists(path.join(root, name))) {
      await mkdir(path.dirname(path.join(backup, name)), { recursive: true });
      await cp(path.join(root, name), path.join(backup, name), { errorOnExist: true, force: false });
    }
  }
  console.log(`Backup: ${backup}`);
  try {
    if (hasDesign) await cp(oldDesign, destination, { recursive: true, errorOnExist: true, force: false });
    await writeCanvasJson(root, "index.json", index);
    if (!manifest) await writeCanvasJson(root, "assets.json", { version: 1, assets: {} });
    await canvasAssetCatalog(root, await ensureCanvasAssets(project, projects, library, boards.flatMap((board) => canvasNodeAssetIds(board.nodes))));
    for (const { editorLayout, ...board } of boards) {
      await writeCanvasJson(root, `editor/${board.id}.json`, editorLayout);
      await writeCanvasJson(root, `boards/${board.id}.json`, { ...board, nodes: board.nodes.map(({ position: _position, ...node }) => node) });
    }
    if (earlyDocument) await writeCanvasFile(root, `documents/${earlyDocument.id}.md`, earlyDocument.markdown);
    if (hasDesign && await exists(path.join(destination, "AGENTS.md"))) {
      const instructions = await readFile(path.join(destination, "AGENTS.md"), "utf8");
      await writeCanvasFile(root, "AGENTS.md", instructions.replaceAll("design/", "canvas/").replaceAll("design_check", "canvas_check").replaceAll("generate_design_media", "generate_canvas_media"));
    }
    await ensureCanvasContract(root, true);
    for (const name of ["index.schema.json", "board.schema.json", "schema.json", "gdd.json", "gdd.md"]) await rm(await canvasPath(root, name), { force: true });
    const checked = await checkCanvasWorkspace(root);
    if (!checked.ok) throw new Error(checked.issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n"));
  } catch (cause) {
    await rm(destination, { recursive: true, force: true });
    throw cause;
  }
  if (hasDesign) await rm(oldDesign, { recursive: true });
  else {
    const instructions = path.join(root, "AGENTS.md");
    if (await exists(instructions)) {
      const original = await readFile(instructions, "utf8");
      await writeFile(instructions, original.replaceAll("canvas.json", "canvas/boards/<board-id>.json").replaceAll("editor/layout.json", "canvas/editor/<board-id>.json").replaceAll("schemas/asset-canvas.schema.json", "canvas/schemas/board.schema.json").replace("- Keep node IDs stable and keep the layout Node IDs exactly synchronized with `canvas/boards/<board-id>.json`.", "- Read `canvas/AGENTS.md` and `canvas/index.json` before editing. Documents are Markdown nodes. Keep node IDs stable; missing positions are placed automatically."));
    }
    for (const name of ["canvas.json", "editor/layout.json", "schemas/asset-canvas.schema.json", "schemas/editor-layout.schema.json"]) await rm(path.join(root, name), { force: true });
  }
  console.log(`Migrated: ${project.name} (${boards.length} boards)`);
}
