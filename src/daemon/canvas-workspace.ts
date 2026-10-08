import { createHash, randomUUID } from "node:crypto";
import { resolveVideoMentions } from "../shared/video-references.js";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import type { AssetCanvasNode, PromptImage, RunToolRequest, ToolJob, ToolId } from "../shared/contracts.js";
import { createCanvasBoard, fitCanvasLayout, isCanvasBoard, isCanvasIndex, CANVAS_INDEX_SCHEMA, CANVAS_BOARD_SCHEMA, CANVAS_LAYOUT_SCHEMA, type CanvasBoard, type CanvasBoardDetail, type CanvasWorkspaceDetail, type CanvasWorkspaceIndex } from "../shared/canvas-workspace.js";
import { CANVAS_ASSETS_SCHEMA, canvasNodeAssetIds } from "../shared/canvas-assets.js";
import { combineAssetCanvasPrompt, createAssetCanvasDocument, resolveAssetCanvasAssetId } from "../shared/asset-canvas.js";
import { buildModel3DToolRequest } from "../shared/generation-config.js";
import { getWorkspaceMedia } from "./workspace.js";
import { createCanvasDocument, canvasDocumentPath, type CanvasDocumentDetail, type CanvasMarkdownDocument } from "../shared/canvas-document.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";
import { CanvasError, canvasPath, parseCanvasJson, readCanvasFile, writeCanvasFile as writeAtomic, writeCanvasJson as writeJson } from "./canvas-files.js";
import { canvasAssetCatalog, canvasLibraryAsset, ensureCanvasAssets, readCanvasAssets } from "./canvas-assets.js";
export { CanvasError } from "./canvas-files.js";

const locks = new Map<string, Promise<unknown>>();
export function withCanvasLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const result = (locks.get(workspace) ?? Promise.resolve()).catch(() => {}).then(operation);
  locks.set(workspace, result);
  void result.finally(() => { if (locks.get(workspace) === result) locks.delete(workspace); }).catch(() => {});
  return result;
}
const validId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new CanvasError("Invalid canvas ID"); return id; };
const revision = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const CANVAS_INSTRUCTIONS = `# Canvas workspace

Canvas files are the source of truth in both Design and Asset Canvas. Use normal read, edit, and write tools to create and change boards, nodes, documents, and references.

- Read README.md and schemas/ before changing a contract. Run canvas_check after editing.
- index.json lists boards, documents, and the main document. Keep IDs stable; names and titles may change.
- boards/<id>.json contains nodes and their content. Every node may have a title and a description of its purpose. Document bodies live in documents/<id>.md, referenced by documentId.
- Give nodes meaningful titles. Descriptions explain their intended role; do not describe unseen image pixels as verified facts.
- editor/<board-id>.json stores positions and zoom. New nodes are placed automatically; layout edits are only needed when the user asks to arrange the canvas.
- assets.json maps asset IDs to names, workspace-relative paths, optional descriptions and generation prompts. Use the same ID for the same asset across boards. References with type "library" resolve through this manifest. libraryAssetId records provenance; local files remain usable without the Library.
- Read actual image files with read when judging their appearance. A name, description, or generation prompt is not proof of what the image shows.
- promptSource references a text or document node. images, references, and source declare media dependencies; their canvas lines are derived. Do not duplicate these relationships in edges.
- To add a local image, place it under assets/, add its path to assets.json, and reference its ID from an asset node or a generation node.
- Do not trigger generation merely by editing a prompt or adding a reference. A game-creation request includes its needed media unless the user narrows the scope. Use generate_canvas_media with the saved boardId and nodeId for generation; it uses the node settings and shared generation history.
- Removing a node or board keeps its documents and assets. Remove references to a deleted node from the same board.
- An editor-context block identifies the current board and selected nodes. Read the referenced files before editing, and preserve other user changes.
`;
const CANVAS_README = `# Canvas workspace

The canvas edits ordinary project files. Documents are Markdown and media files are available directly under assets/ in the project.

| File | Content |
| --- | --- |
| index.json | Board IDs/names, document IDs/titles, and mainDocumentId |
| boards/<id>.json | Node IDs, optional titles/descriptions, content and references |
| documents/<id>.md | Canonical document body |
| assets.json | Asset IDs, names, project-relative file paths, descriptions and generation prompts |
| editor/<id>.json | Positions and canvas viewport; missing node positions are filled automatically |
| schemas/ | Exact persisted file contracts |
| jobs.json | Generation history managed by the application |

Read AGENTS.md for editing conventions. Asset paths are relative to the project root; Markdown image links are relative to the document file. Node IDs need only be unique within their board; asset and document IDs are shared across the canvas workspace.
`;
export async function ensureCanvasContract(workspace: string, replaceReadme = false): Promise<void> {
  for (const [name, value] of [["index", CANVAS_INDEX_SCHEMA], ["board", CANVAS_BOARD_SCHEMA], ["layout", CANVAS_LAYOUT_SCHEMA], ["assets", CANVAS_ASSETS_SCHEMA]] as const) {
    const file = `schemas/${name}.schema.json`, text = `${JSON.stringify(value, null, 2)}\n`;
    if (await readCanvasFile(workspace, file) !== text) await writeAtomic(workspace, file, text);
  }
  for (const [name, text] of [["AGENTS.md", CANVAS_INSTRUCTIONS], ["README.md", CANVAS_README]] as const) if ((replaceReadme && name === "README.md") || await readCanvasFile(workspace, name) === undefined) await writeAtomic(workspace, name, text);
}
export async function readCanvasIndex(workspace: string): Promise<CanvasWorkspaceIndex | undefined> {
  const text = await readCanvasFile(workspace, "index.json", 512_000);
  if (text === undefined) return undefined;
  const value = parseCanvasJson<CanvasWorkspaceIndex>(text, "index.json", CANVAS_INDEX_SCHEMA);
  if (!isCanvasIndex(value)) throw new CanvasError("canvas/index.json: duplicate IDs or unknown mainDocumentId");
  return value;
}
async function ensureCanvasIndex(workspace: string): Promise<CanvasWorkspaceIndex> {
  const current = await readCanvasIndex(workspace);
  if (current) return current;
  for (const legacy of ["design", "canvas.json"]) {
    try { await lstat(path.join(workspace, legacy)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
    throw new CanvasError("This project uses the previous canvas format. Stop OhMyGame and run scripts/migrate-canvas-workspaces.ts against its data directory before opening it.", 409);
  }
  try {
    await lstat(path.join(workspace, "canvas"));
    throw new CanvasError("The canvas directory is missing index.json. Restore its index before opening it.", 409);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const board = createCanvasBoard();
  const index: CanvasWorkspaceIndex = { version: 1, boards: [{ id: board.id, name: "Untitled" }], documents: [] };
  await writeCanvasBoard(workspace, board);
  await writeJson(workspace, "assets.json", { version: 1, assets: {} });
  await ensureCanvasContract(workspace);
  await writeJson(workspace, "index.json", index);
  return index;
}
export async function readCanvasDocument(workspace: string, documentId?: string): Promise<CanvasDocumentDetail | undefined> {
  const index = await readCanvasIndex(workspace), id = documentId ?? index?.mainDocumentId;
  if (!id) return undefined;
  const entry = index?.documents.find((document) => document.id === validId(id));
  if (!entry) return undefined;
  return readDocumentEntry(workspace, entry);
}
async function readDocumentEntry(workspace: string, entry: CanvasWorkspaceIndex["documents"][number]): Promise<CanvasDocumentDetail> {
  const markdown = await readFile(await canvasPath(workspace, `documents/${entry.id}.md`), "utf8");
  if (Buffer.byteLength(markdown) > 2 * 1024 * 1024) throw new CanvasError("Canvas document is too large");
  const document = { ...entry, markdown };
  return { document, revision: revision(document) };
}
export function readCanvasDocuments(workspace: string, index: CanvasWorkspaceIndex): Promise<CanvasDocumentDetail[]> {
  return Promise.all(index.documents.map((entry) => readDocumentEntry(workspace, entry)));
}
export async function writeCanvasDocument(workspace: string, document: CanvasMarkdownDocument, selectMain = true): Promise<CanvasDocumentDetail> {
  if (!isCanvasDocument(document) || Buffer.byteLength(document.markdown) > 2 * 1024 * 1024) throw new CanvasError("Invalid or oversized canvas document");
  const index = await ensureCanvasIndex(workspace);
  const entry = index.documents.find((entry) => entry.id === document.id);
  if (!entry && index.documents.length >= 200) throw new CanvasError("The workspace supports up to 200 documents");
  await writeAtomic(workspace, `documents/${validId(document.id)}.md`, document.markdown);
  if (entry) entry.title = document.title;
  else index.documents.push({ id: document.id, title: document.title });
  if (selectMain) index.mainDocumentId ??= document.id;
  await writeJson(workspace, "index.json", index);
  return { document, revision: revision(document) };
}
export async function readCanvasBoard(workspace: string, id: string): Promise<CanvasBoardDetail | undefined> {
  const name = `boards/${validId(id)}.json`, text = await readCanvasFile(workspace, name);
  if (text === undefined) return undefined;
  const raw = parseCanvasJson<Omit<CanvasBoard, "editorLayout">>(text, name, CANVAS_BOARD_SCHEMA);
  const layoutName = `editor/${id}.json`, layoutText = await readCanvasFile(workspace, layoutName);
  const layout = layoutText === undefined ? createAssetCanvasDocument().editorLayout : parseCanvasJson<CanvasBoard["editorLayout"]>(layoutText, layoutName, CANVAS_LAYOUT_SCHEMA);
  const editorLayout = fitCanvasLayout(raw.nodes, layout);
  const board = { ...raw, editorLayout, nodes: raw.nodes.map((node) => ({ ...node, position: editorLayout.nodes[node.id]! })) };
  if (!isCanvasBoard(board) || board.id !== id) throw new CanvasError(`canvas/${name}: invalid node IDs or references`);
  return { board, revision: revision([text, layoutText ?? ""]) };
}
async function writeCanvasBoard(workspace: string, board: CanvasBoard): Promise<CanvasBoardDetail> {
  if (!isCanvasBoard(board)) throw new CanvasError("Invalid canvas board");
  const { editorLayout, ...content } = board;
  const persisted = { ...content, nodes: board.nodes.map(({ position: _position, ...node }) => node) };
  const text = `${JSON.stringify(persisted, null, 2)}\n`;
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new CanvasError("Canvas board is too large");
  await writeAtomic(workspace, `boards/${validId(board.id)}.json`, text);
  await writeJson(workspace, `editor/${board.id}.json`, editorLayout);
  return (await readCanvasBoard(workspace, board.id))!;
}
export async function canvasReferencesAsset(workspace: string, id: string): Promise<boolean> {
  const index = await readCanvasIndex(workspace);
  const manifest = await readCanvasAssets(workspace);
  const ids = new Set([id, ...Object.entries(manifest.assets).filter(([, asset]) => asset.libraryAssetId === id).map(([key]) => key)]);
  for (const entry of index?.boards ?? []) {
    const detail = await readCanvasBoard(workspace, entry.id);
    if (detail && canvasNodeAssetIds(detail.board.nodes).some((assetId) => ids.has(assetId))) return true;
  }
  return false;
}

export async function canvasLibraryAssetUsage(workspace: string): Promise<Map<string, boolean>> {
  const index = await readCanvasIndex(workspace);
  const manifest = await readCanvasAssets(workspace);
  const usage = new Map<string, boolean>();
  const libraryId = (id: string) => manifest.assets[id]?.libraryAssetId ?? id;
  for (const id of Object.keys(manifest.assets)) usage.set(libraryId(id), false);
  for (const entry of index?.boards ?? []) {
    const detail = await readCanvasBoard(workspace, entry.id);
    if (!detail) throw new CanvasError("Canvas board data is missing", 409);
    for (const id of canvasNodeAssetIds(detail.board.nodes)) {
      if (!usage.has(libraryId(id))) usage.set(libraryId(id), false);
    }
    for (const node of detail.board.nodes) {
      if ("assetId" in node.data && node.data.assetId) usage.set(libraryId(node.data.assetId), true);
    }
  }
  return usage;
}
export async function renameCanvasAssetPaths(workspace: string, from: string, to: string): Promise<void> {
  await withCanvasLock(workspace, async () => {
    const manifest = await readCanvasAssets(workspace);
    const renamed = Object.values(manifest.assets).filter((asset) => asset.path === from || asset.path.startsWith(`${from}/`));
    if (!renamed.length) return;
    const links = renamed.map((asset) => {
      const oldPath = asset.path;
      asset.path = `${to}${oldPath.slice(from.length)}`;
      if (oldPath === from && asset.name === path.posix.basename(oldPath)) asset.name = path.posix.basename(to);
      return [oldPath, asset.path] as const;
    });
    const index = await readCanvasIndex(workspace);
    const documents = index ? await readCanvasDocuments(workspace, index) : [];
    await writeJson(workspace, "assets.json", manifest);
    for (const detail of documents) {
      let markdown = detail.document.markdown;
      for (const [oldPath, newPath] of links) {
        const link = (file: string) => `../../${file.split("/").map(encodeURIComponent).join("/")}`;
        markdown = markdown.replaceAll(`](${link(oldPath)})`, `](${link(newPath)})`);
      }
      if (markdown !== detail.document.markdown) await writeAtomic(workspace, `documents/${detail.document.id}.md`, markdown);
    }
  });
}

export async function removeCanvasAssetReferences(workspace: string, assetIds: string | readonly string[], options: { localOnly?: boolean } = {}): Promise<void> {
  const requested = new Set(typeof assetIds === "string" ? [assetIds] : assetIds);
  if (!requested.size) return;
  await withCanvasLock(workspace, async () => {
    const index = await readCanvasIndex(workspace);
    const manifest = await readCanvasAssets(workspace);
    const ids = new Set([...requested, ...Object.entries(manifest.assets).filter(([, asset]) => !options.localOnly && asset.libraryAssetId && requested.has(asset.libraryAssetId)).map(([key]) => key)]);
    const boards = await Promise.all((index?.boards ?? []).map(async (entry) => {
      const detail = await readCanvasBoard(workspace, entry.id);
      if (!detail) throw new CanvasError("Canvas board data is missing", 409);
      return detail;
    }));
    const removedLinks = new Set([...ids].flatMap((assetId) => manifest.assets[assetId] ? [`../../${manifest.assets[assetId]!.path.split("/").map(encodeURIComponent).join("/")}`] : []));
    if (index && removedLinks.size) {
      for (const detail of await readCanvasDocuments(workspace, index)) {
        const markdown = detail.document.markdown.replace(/!\[[^\]\n]*\]\(([^)\s]+)\)/g, (image, link: string) => removedLinks.has(link) ? "" : image);
        if (markdown !== detail.document.markdown) await writeAtomic(workspace, `documents/${detail.document.id}.md`, markdown);
      }
    }
    for (const detail of boards) {
      if (!canvasNodeAssetIds(detail.board.nodes).some((assetId) => ids.has(assetId))) continue;
      const removed = new Set(detail.board.nodes.filter((node) => node.type === "asset" && ids.has(node.data.assetId)).map((node) => node.id));
      detail.board.nodes = detail.board.nodes.filter((node) => !removed.has(node.id)).map((node) => {
        const data = { ...node.data };
        if ("assetId" in data && data.assetId && ids.has(data.assetId)) delete data.assetId;
        if ("images" in data) data.images = data.images.filter((reference) => reference.type === "library" ? !ids.has(reference.assetId) : !removed.has(reference.nodeId));
        if ("references" in data) data.references = data.references.filter((reference) => reference.type === "library" ? !ids.has(reference.assetId) : !removed.has(reference.nodeId));
        if ("source" in data && data.source && (data.source.type === "library" ? ids.has(data.source.assetId) : removed.has(data.source.nodeId))) delete data.source;
        return { ...node, data } as AssetCanvasNode;
      });
      detail.board.edges = detail.board.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
      detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, node.position]));
      await writeCanvasBoard(workspace, detail.board);
    }
    if ([...ids].some((assetId) => manifest.assets[assetId])) {
      for (const assetId of ids) delete manifest.assets[assetId];
      await writeJson(workspace, "assets.json", manifest);
    }
  });
}
type StoredJob = ToolJob & { input?: RunToolRequest };
export class CanvasStore {
  readonly #jobs = new Map<string, StoredJob[]>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #executions = new Set<Promise<void>>();
  #closed = false;
  constructor(private readonly projects: ProjectManager, private readonly library: AssetLibrary, private readonly tools: ToolRunner) {}
  #project(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new CanvasError("Project not found", 404);
    if (project.workspaceAvailable === false) throw new CanvasError("Canvas requires an available project workspace", 409);
    return project;
  }
  async read(id: string, documentId?: string) { return readCanvasDocument(this.#project(id).workspacePath, documentId); }
  async exportAsset(id: string, assetId: string) { return { assetId: await canvasLibraryAsset(this.#project(id), this.library, assetId) }; }
  async workspace(id: string): Promise<CanvasWorkspaceDetail> {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const index = await ensureCanvasIndex(workspace), documents = await readCanvasDocuments(workspace, index);
      await ensureCanvasContract(workspace);
      const assets = await canvasAssetCatalog(workspace, await readCanvasAssets(workspace));
      return { ...index, assets, documents: documents.map((detail) => ({ ...detail.document, revision: detail.revision, source: canvasDocumentPath(detail.document.id), main: detail.document.id === index.mainDocumentId })) };
    });
  }
  async createDocument(id: string, title: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, () => writeCanvasDocument(workspace, createCanvasDocument(title.trim() || "Untitled document"), project.type !== "asset-canvas"));
  }
  async save(id: string, document: CanvasMarkdownDocument, expected: string, documentId?: string) {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await readCanvasDocument(workspace, documentId);
      if (!current) throw new CanvasError("Document not found", 404);
      if (current.revision !== expected) throw new CanvasError("The document changed. Review the latest version before saving.", 409);
      if (current.document.id !== document.id) throw new CanvasError("The document ID must stay unchanged");
      return writeCanvasDocument(workspace, document, this.#project(id).type !== "asset-canvas");
    });
  }
  async setMainDocument(id: string, documentId: string) {
    if (this.#project(id).type === "asset-canvas") throw new CanvasError("Main game design documents require a game project", 409);
    const workspace = this.#project(id).workspacePath;
    await withCanvasLock(workspace, async () => {
      if (!await readCanvasDocument(workspace, documentId)) throw new CanvasError("Document not found", 404);
      const index = (await readCanvasIndex(workspace))!; index.mainDocumentId = documentId;
      await writeJson(workspace, "index.json", index);
    });
  }
  async board(id: string, boardId: string): Promise<CanvasBoardDetail> {
    const workspace = this.#project(id).workspacePath;
    if (!(await readCanvasIndex(workspace))?.boards.some((board) => board.id === boardId)) throw new CanvasError("Canvas board not found", 404);
    const detail = await readCanvasBoard(workspace, boardId);
    if (!detail) throw new CanvasError("Canvas board data is missing", 409);
    return detail;
  }
  async saveBoard(id: string, board: CanvasBoard, expected: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await this.board(id, board.id);
      if (current.revision !== expected) throw new CanvasError("The board changed. Reload the latest board before saving.", 409);
      if (!isCanvasBoard(board)) throw new CanvasError("Invalid canvas board");
      const documents = (await readCanvasIndex(workspace))!.documents;
      if (board.nodes.some((node) => node.type === "document" && !documents.some((document) => document.id === node.data.documentId))) throw new CanvasError("Document reference not found", 404);
      await canvasAssetCatalog(workspace, await ensureCanvasAssets(project, this.projects, this.library, canvasNodeAssetIds(board.nodes)));
      const detail = await writeCanvasBoard(workspace, board);
      await this.projects.touch(id);
      return detail;
    });
  }
  async changeBoards(id: string, action: { type: "create"; name: string } | { type: "rename" | "delete" | "move"; boardId: string; name?: string; direction?: number }) {
    if (this.#project(id).type === "asset-canvas") throw new CanvasError("Asset Canvas uses one default board", 409);
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const index = await ensureCanvasIndex(workspace);
      if (action.type === "create") {
        if (index.boards.length >= 100) throw new CanvasError("The workspace supports up to 100 boards");
        const board = createCanvasBoard(); await writeCanvasBoard(workspace, board); index.boards.push({ id: board.id, name: action.name.trim() || "Untitled" });
      } else {
        const position = index.boards.findIndex((board) => board.id === action.boardId);
        if (position < 0) throw new CanvasError("Canvas board not found", 404);
        if (action.type === "rename") index.boards[position]!.name = action.name?.trim() || "Untitled";
        if (action.type === "move") { const target = Math.max(0, Math.min(index.boards.length - 1, position + (action.direction === -1 ? -1 : 1))); [index.boards[position], index.boards[target]] = [index.boards[target]!, index.boards[position]!]; }
        if (action.type === "delete") { if (index.boards.length === 1) throw new CanvasError("Keep at least one board", 409); index.boards.splice(position, 1); }
      }
      await writeJson(workspace, "index.json", index);
      if (action.type === "delete") {
        await rm(await canvasPath(workspace, `boards/${validId(action.boardId)}.json`), { force: true });
        await rm(await canvasPath(workspace, `editor/${action.boardId}.json`), { force: true });
      }
      return index;
    });
  }
  async insertAsset(id: string, documentId: string, assetId: string): Promise<CanvasDocumentDetail> {
    const workspace = this.#project(id).workspacePath;
    return withCanvasLock(workspace, async () => {
      const manifest = await ensureCanvasAssets(this.#project(id), this.projects, this.library, [assetId]);
      const asset = (await canvasAssetCatalog(workspace, manifest)).find((asset) => asset.id === assetId)!;
      if (asset.mediaType !== "image") throw new CanvasError("Choose an image asset");
      const detail = await readCanvasDocument(workspace, documentId);
      if (!detail) throw new CanvasError("Document not found", 404);
      const label = asset.name.replace(/[\[\]\n]/g, "");
      const link = asset.path.split("/").map(encodeURIComponent).join("/");
      const saved = await writeCanvasDocument(workspace, { ...detail.document, markdown: `${detail.document.markdown.trimEnd()}\n\n![${label}](../../${link})\n` }, this.#project(id).type !== "asset-canvas");
      if (asset.libraryAssetId && this.library.get(asset.libraryAssetId)) await this.library.save(asset.libraryAssetId);
      return saved;
    });
  }
  async #loadJobs(id: string): Promise<StoredJob[]> {
    if (this.#jobs.has(id)) return this.#jobs.get(id)!;
    await ensureCanvasIndex(this.#project(id).workspacePath);
    let jobs: StoredJob[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(await canvasPath(this.#project(id).workspacePath, "jobs.json"), "utf8"));
      if (!Array.isArray(value) || value.length > 1000 || value.some((job) => !job || typeof job.id !== "string" || job.context?.projectId !== id || typeof job.context?.boardId !== "string" || typeof job.context?.nodeId !== "string" || !["running", "succeeded", "failed", "cancelled"].includes(job.status))) throw new CanvasError("Invalid generation history");
      jobs = value.map((job) => job.status === "running" ? { ...job, status: "cancelled", error: "Generation was interrupted. Retry to generate again." } : job);
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    this.#jobs.set(id, jobs); await this.#saveJobs(id); return jobs;
  }
  #saveJobs(id: string) { return writeJson(this.#project(id).workspacePath, "jobs.json", this.#jobs.get(id) ?? []); }
  async jobs(id: string): Promise<ToolJob[]> { return withCanvasLock(this.#project(id).workspacePath, async () => (await this.#loadJobs(id)).map(({ input: _input, ...job }) => structuredClone(job))); }
  async start(id: string, boardId: string, nodeId: string, toolId: ToolId, input: RunToolRequest, expectedRevision?: string): Promise<ToolJob> {
    const workspace = this.#project(id).workspacePath;
    const { job, prepared } = await withCanvasLock(workspace, async () => {
      if (this.#closed) throw new CanvasError("Generation is shutting down", 503);
      const detail = await this.board(id, boardId);
      if (expectedRevision && detail.revision !== expectedRevision) throw new CanvasError("The node settings changed before generation. Read the current board and try again.", 409);
      const node = detail.board.nodes.find((node) => node.id === nodeId);
      if (!node || ({ "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d" } as Record<string, string>)[toolId] !== node.type) throw new CanvasError("Generation node not found", 404);
      const jobs = await this.#loadJobs(id);
      if (jobs.some((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId && job.status === "running")) throw new CanvasError("This node is already generating", 409);
      const prepared = structuredClone(input);
      if (toolId === "generate-video" && "references" in prepared) for (const reference of prepared.references ?? []) reference.assetId = await canvasLibraryAsset(this.#project(id), this.library, reference.assetId);
      if (toolId === "animate-3d" && "assetId" in prepared) prepared.assetId = await canvasLibraryAsset(this.#project(id), this.library, prepared.assetId);
      const job: StoredJob = { id: randomUUID(), toolId, createdAt: new Date().toISOString(), status: "running", title: "prompt" in input ? input.prompt.slice(0, 200) : "Model 3D", context: { projectId: id, boardId, nodeId }, input: structuredClone(input) };
      if (jobs.filter((job) => job.status === "running").length >= 20) throw new CanvasError("Too many active generation jobs", 409);
      this.#jobs.set(id, [job, ...jobs.filter((job) => job.status === "running"), ...jobs.filter((job) => job.status !== "running").slice(0, 80)]); await this.#saveJobs(id); return { job, prepared };
    });
    const controller = new AbortController(); this.#controllers.set(job.id, controller);
    const execution = this.#execute(id, job, prepared, controller); this.#executions.add(execution);
    void execution.finally(() => this.#executions.delete(execution));
    const { input: _input, ...publicJob } = job; return structuredClone(publicJob);
  }
  async generateNode(id: string, boardId: string, nodeId: string): Promise<ToolJob> {
    const project = this.#project(id), { board, revision } = await this.board(id, boardId);
    const node = board.nodes.find((node) => node.id === nodeId);
    if (!node || !["image", "video", "model-3d", "animate-3d"].includes(node.type)) throw new CanvasError("Choose a media generation node");
    const manifest = await readCanvasAssets(project.workspacePath);
    const assetId = (reference: Parameters<typeof resolveAssetCanvasAssetId>[1]): string => {
      const id = resolveAssetCanvasAssetId(board.nodes, reference);
      if (!id || !manifest.assets[id]) throw new CanvasError("A referenced node has no saved output. Generate it first.");
      return id;
    };
    const image = async (reference: Parameters<typeof assetId>[0]): Promise<PromptImage> => {
      const source = await getWorkspaceMedia(project.workspacePath, manifest.assets[assetId(reference)]!.path);
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(source.contentType)) throw new CanvasError("Reference images must be PNG, JPEG, WebP or GIF");
      return { mediaType: source.contentType as PromptImage["mediaType"], data: (await readFile(source.absolutePath)).toString("base64") };
    };
    if (node.type === "animate-3d") {
      if (!node.data.source || !node.data.actionIds.length) throw new CanvasError("Choose a source model and animation actions first");
      return this.start(id, boardId, nodeId, "animate-3d", { assetId: assetId(node.data.source), actionIds: node.data.actionIds, heightMeters: node.data.heightMeters }, revision);
    }
    if (node.type === "model-3d") {
      if (!node.data.images.length) throw new CanvasError("Add a reference image before generating");
      const images = await Promise.all(node.data.images.map(async (reference) => {
        const source = await image(reference);
        if (source.mediaType === "image/webp") {
          const png = await convertToPng(source.data, source.mediaType);
          if (!png) throw new CanvasError("Could not convert the WebP reference image to PNG");
          return { mediaType: "image/png" as const, data: png.data };
        }
        if (source.mediaType !== "image/png" && source.mediaType !== "image/jpeg") throw new CanvasError("3D generation requires PNG, JPEG or WebP reference images");
        return source;
      }));
      return this.start(id, boardId, nodeId, "image-to-3d", buildModel3DToolRequest(node.data, images), revision);
    }
    if (node.type !== "image" && node.type !== "video") throw new CanvasError("Unsupported generation node");
    const linked = board.nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
    const text = linked?.type === "text" ? linked.data.text : linked?.type === "document" ? (await this.read(id, linked.data.documentId))?.document.markdown : undefined;
    const prompt = combineAssetCanvasPrompt(text, node.data.prompt);
    if (!prompt) throw new CanvasError("Add a prompt before generating");
    if (node.type === "image") return this.start(id, boardId, nodeId, "generate-image", { prompt, resolution: node.data.resolution, aspectRatio: node.data.aspectRatio, ...(node.data.model ? { imageModel: node.data.model } : {}), images: await Promise.all(node.data.images.map(image)) }, revision);
    const catalog = await canvasAssetCatalog(project.workspacePath, manifest);
    const references = node.data.references.map((reference) => {
      const id = assetId(reference), asset = catalog.find((asset) => asset.id === id)!;
      if (asset.mediaType !== "image") throw new CanvasError("Video generation currently accepts image references only");
      return { type: "image" as const, assetId: id };
    });
    let resolvedPrompt: string;
    try { resolvedPrompt = resolveVideoMentions(prompt, node.data.references, node.data.referenceMentions); }
    catch (cause) { throw new CanvasError(cause instanceof Error ? cause.message : String(cause)); }
    return this.start(id, boardId, nodeId, "generate-video", { prompt: resolvedPrompt, model: node.data.model, resolution: node.data.resolution, aspectRatio: node.data.aspectRatio, duration: node.data.duration, references, ...(node.data.referenceMode ? { referenceMode: node.data.referenceMode } : {}) }, revision);
  }
  async #execute(id: string, job: StoredJob, prepared: RunToolRequest, controller: AbortController) {
    try {
      const run = await this.tools.run(job.toolId, prepared, controller.signal); controller.signal.throwIfAborted();
      const output = run.files[0];
      if (!output?.assetId) throw new CanvasError("Generation returned no Library asset", 502);
      await withCanvasLock(this.#project(id).workspacePath, async () => {
        if (controller.signal.aborted) return;
        const workspace = this.#project(id).workspacePath, boardId = job.context!.boardId!;
        await ensureCanvasAssets(this.#project(id), this.projects, this.library, [output.assetId!]);
        if ((await readCanvasIndex(workspace))?.boards.some((board) => board.id === boardId)) {
          const detail = await readCanvasBoard(workspace, boardId), node = detail?.board.nodes.find((node) => node.id === job.context!.nodeId);
          const expectedType = { "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d" }[job.toolId];
          if (detail && node?.type === expectedType) { Object.assign(node.data, { assetId: output.assetId }); await writeCanvasBoard(workspace, detail.board); }
        }
        job.run = run; job.status = "succeeded"; delete job.input; await this.#saveJobs(id);
      });
      await this.tools.removeRun(run.id).catch(() => {});
    } catch (cause) {
      job.status = controller.signal.aborted ? "cancelled" : "failed"; job.error = cause instanceof Error ? cause.message : String(cause);
      try { await withCanvasLock(this.#project(id).workspacePath, () => this.#saveJobs(id)); } catch { /* Removed projects have no history to update. */ }
    } finally { this.#controllers.delete(job.id); }
  }
  async cancel(id: string, jobId: string): Promise<ToolJob> {
    return withCanvasLock(this.#project(id).workspacePath, async () => {
      const job = (await this.#loadJobs(id)).find((job) => job.id === jobId);
      if (!job) throw new CanvasError("Generation job not found", 404);
      if (job.status === "running") { job.status = "cancelled"; job.error = "Generation cancelled"; this.#controllers.get(job.id)?.abort(); await this.#saveJobs(id); }
      const { input: _input, ...result } = job; return structuredClone(result);
    });
  }
  async retry(id: string, jobId: string): Promise<ToolJob> {
    const job = await withCanvasLock(this.#project(id).workspacePath, async () => (await this.#loadJobs(id)).find((job) => job.id === jobId));
    if (!job || !job.input || !["failed", "cancelled"].includes(job.status)) throw new CanvasError("This job cannot be retried", 409);
    return this.start(id, job.context!.boardId!, job.context!.nodeId, job.toolId, job.input);
  }
  async cancelProject(id: string) { for (const job of this.#jobs.get(id) ?? []) if (job.status === "running") await this.cancel(id, job.id); this.#jobs.delete(id); }
  async close() { this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(); await Promise.allSettled(this.#executions); }
}
