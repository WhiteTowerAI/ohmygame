import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import type { AssetCanvasNode, RunToolRequest, ToolJob, ToolId } from "../shared/contracts.js";
import { createDesignBoard, isDesignBoard, isDesignIndex, DESIGN_INDEX_SCHEMA, DESIGN_BOARD_SCHEMA, type DesignBoard, type DesignBoardDetail, type DesignWorkspaceDetail, type DesignWorkspaceIndex } from "../shared/design-boards.js";
import { createGameDesign, designDocumentPath, type GameDesignDetail, type GameDesignDocument } from "../shared/game-design.js";
import { isGameDesign } from "../shared/game-design-schema.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";

export class GameDesignError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const locks = new Map<string, Promise<unknown>>();
export function withDesignLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const result = (locks.get(workspace) ?? Promise.resolve()).catch(() => {}).then(operation);
  locks.set(workspace, result);
  void result.finally(() => { if (locks.get(workspace) === result) locks.delete(workspace); }).catch(() => {});
  return result;
}
const validId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new GameDesignError("Invalid design ID"); return id; };
const revision = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
async function designPath(workspace: string, name: string, create = false): Promise<string> {
  const segments = name.split("/");
  if (segments.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")) throw new GameDesignError("Invalid design path");
  let directory = workspace;
  for (const part of ["design", ...segments.slice(0, -1)]) {
    directory = path.join(directory, part);
    if (create) await mkdir(directory).catch((cause) => { if (cause.code !== "EEXIST") throw cause; });
    if ((await lstat(directory)).isSymbolicLink()) throw new GameDesignError("Design directories must not be symbolic links");
  }
  const file = path.join(directory, segments.at(-1)!);
  try { if ((await lstat(file)).isSymbolicLink()) throw new GameDesignError("Design files must not be symbolic links"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  return file;
}
async function writeAtomic(workspace: string, name: string, text: string): Promise<void> {
  const destination = await designPath(workspace, name, true), temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { encoding: "utf8", flag: "wx" }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}
const writeJson = (workspace: string, name: string, value: unknown) => writeAtomic(workspace, name, `${JSON.stringify(value, null, 2)}\n`);
export async function readDesignIndex(workspace: string): Promise<DesignWorkspaceIndex | undefined> {
  let text: string;
  try { text = await readFile(await designPath(workspace, "index.json"), "utf8"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
  if (Buffer.byteLength(text) > 512_000) throw new GameDesignError("Design index is too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new GameDesignError("Invalid design index JSON"); }
  if (!isDesignIndex(value)) throw new GameDesignError("Invalid design workspace index");
  return value;
}
async function ensureDesignIndex(workspace: string): Promise<DesignWorkspaceIndex> {
  const current = await readDesignIndex(workspace);
  if (current) return current;
  const board = createDesignBoard();
  const index: DesignWorkspaceIndex = { version: 1, boards: [{ id: board.id, name: "Untitled" }], documents: [] };
  await writeDesignBoard(workspace, board);
  await writeJson(workspace, "index.schema.json", DESIGN_INDEX_SCHEMA);
  await writeJson(workspace, "board.schema.json", DESIGN_BOARD_SCHEMA);
  await writeAtomic(workspace, "README.md", "# Design workspace\n\nindex.json lists freely named boards, document IDs/titles and the main design document. documents/<id>.md is the editable Markdown source. boards/<id>.json uses the Asset Canvas node model, with document nodes referencing document IDs. Positions and zoom are in editorLayout. Read index.schema.json and board.schema.json before editing. Keep IDs stable. Removing a board or node keeps documents and Library assets. Generate media only when explicitly requested.\n");
  await writeJson(workspace, "index.json", index);
  return index;
}
export async function readGameDesign(workspace: string, documentId?: string): Promise<GameDesignDetail | undefined> {
  const index = await readDesignIndex(workspace), id = documentId ?? index?.mainDocumentId;
  if (!id) return undefined;
  const entry = index?.documents.find((document) => document.id === validId(id));
  if (!entry) return undefined;
  return readDesignDocument(workspace, entry);
}
async function readDesignDocument(workspace: string, entry: DesignWorkspaceIndex["documents"][number]): Promise<GameDesignDetail> {
  const markdown = await readFile(await designPath(workspace, `documents/${entry.id}.md`), "utf8");
  if (Buffer.byteLength(markdown) > 2 * 1024 * 1024) throw new GameDesignError("Design document is too large");
  const document = { ...entry, markdown };
  return { document, revision: revision(document) };
}
export function readGameDesignDocuments(workspace: string, index: DesignWorkspaceIndex): Promise<GameDesignDetail[]> {
  return Promise.all(index.documents.map((entry) => readDesignDocument(workspace, entry)));
}
export async function writeGameDesign(workspace: string, document: GameDesignDocument): Promise<GameDesignDetail> {
  if (!isGameDesign(document) || Buffer.byteLength(document.markdown) > 2 * 1024 * 1024) throw new GameDesignError("Invalid or oversized design document");
  const index = await ensureDesignIndex(workspace);
  const entry = index.documents.find((entry) => entry.id === document.id);
  if (!entry && index.documents.length >= 200) throw new GameDesignError("The workspace supports up to 200 documents");
  await writeAtomic(workspace, `documents/${validId(document.id)}.md`, document.markdown);
  if (entry) entry.title = document.title;
  else index.documents.push({ id: document.id, title: document.title });
  index.mainDocumentId ??= document.id;
  await writeJson(workspace, "index.json", index);
  return { document, revision: revision(document) };
}
export async function readDesignBoard(workspace: string, id: string): Promise<DesignBoardDetail | undefined> {
  let text: string;
  try { text = await readFile(await designPath(workspace, `boards/${validId(id)}.json`), "utf8"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new GameDesignError("Design board is too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new GameDesignError("Invalid design board JSON"); }
  if (!Check(DESIGN_BOARD_SCHEMA, value)) throw new GameDesignError("Invalid design board");
  const raw = value as DesignBoard;
  const board = { ...raw, nodes: Array.isArray(raw?.nodes) ? raw.nodes.map((node) => ({ ...node, position: raw.editorLayout?.nodes[node.id] })) : undefined };
  if (!isDesignBoard(board) || board.id !== id) throw new GameDesignError("Invalid design board");
  return { board, revision: revision(text) };
}
async function writeDesignBoard(workspace: string, board: DesignBoard): Promise<DesignBoardDetail> {
  if (!isDesignBoard(board)) throw new GameDesignError("Invalid design board");
  const persisted = { ...board, nodes: board.nodes.map(({ position: _position, ...node }) => node) };
  const text = `${JSON.stringify(persisted, null, 2)}\n`;
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new GameDesignError("Design board is too large");
  await writeAtomic(workspace, `boards/${validId(board.id)}.json`, text);
  return { board, revision: revision(text) };
}
function nodeReferencesAsset(node: AssetCanvasNode, id: string): boolean {
  return ("assetId" in node.data && node.data.assetId === id) || ((node.type === "image" || node.type === "model-3d") && node.data.images.some((reference) => reference.type === "library" && reference.assetId === id)) || (node.type === "video" && node.data.references.some((reference) => reference.type === "library" && reference.assetId === id)) || (node.type === "animate-3d" && node.data.source?.type === "library" && node.data.source.assetId === id);
}
export async function designReferencesAsset(workspace: string, id: string): Promise<boolean> {
  const index = await readDesignIndex(workspace);
  for (const board of index?.boards ?? []) if ((await readDesignBoard(workspace, board.id))?.board.nodes.some((node) => nodeReferencesAsset(node, id))) return true;
  return false;
}
export async function removeDesignAssetReferences(workspace: string, id: string): Promise<void> {
  await withDesignLock(workspace, async () => {
    const index = await readDesignIndex(workspace);
    for (const entry of index?.boards ?? []) {
      const detail = await readDesignBoard(workspace, entry.id);
      if (!detail) throw new GameDesignError("Design board data is missing", 409);
      const removed = new Set(detail.board.nodes.filter((node) => node.type === "asset" && node.data.assetId === id).map((node) => node.id));
      detail.board.nodes = detail.board.nodes.filter((node) => !removed.has(node.id)).map((node) => {
        const data = { ...node.data };
        if ("assetId" in data && data.assetId === id) delete data.assetId;
        if ("images" in data) data.images = data.images.filter((reference) => reference.type === "library" ? reference.assetId !== id : !removed.has(reference.nodeId));
        if ("references" in data) data.references = data.references.filter((reference) => reference.type === "library" ? reference.assetId !== id : !removed.has(reference.nodeId));
        if ("source" in data && data.source && (data.source.type === "library" ? data.source.assetId === id : removed.has(data.source.nodeId))) delete data.source;
        return { ...node, data } as AssetCanvasNode;
      });
      detail.board.edges = detail.board.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
      detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, node.position]));
      await writeDesignBoard(workspace, detail.board);
    }
  });
}
type StoredJob = ToolJob & { input?: RunToolRequest };
export class GameDesignStore {
  readonly #jobs = new Map<string, StoredJob[]>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #executions = new Set<Promise<void>>();
  #closed = false;
  constructor(private readonly projects: ProjectManager, private readonly library: AssetLibrary, private readonly tools: ToolRunner) {}
  #project(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new GameDesignError("Project not found", 404);
    if (project.type === "asset-canvas" || project.workspaceAvailable === false) throw new GameDesignError("Design requires an available game project", 409);
    return project;
  }
  async read(id: string, documentId?: string) { return readGameDesign(this.#project(id).workspacePath, documentId); }
  async workspace(id: string): Promise<DesignWorkspaceDetail> {
    const workspace = this.#project(id).workspacePath;
    return withDesignLock(workspace, async () => {
      const index = await ensureDesignIndex(workspace), documents = await readGameDesignDocuments(workspace, index);
      return { ...index, documents: documents.map((detail) => ({ ...detail.document, revision: detail.revision, source: designDocumentPath(detail.document.id), main: detail.document.id === index.mainDocumentId })) };
    });
  }
  async createDocument(id: string, title: string) {
    const workspace = this.#project(id).workspacePath;
    return withDesignLock(workspace, () => writeGameDesign(workspace, createGameDesign(title.trim() || "Untitled document")));
  }
  async save(id: string, document: GameDesignDocument, expected: string, documentId?: string) {
    const workspace = this.#project(id).workspacePath;
    return withDesignLock(workspace, async () => {
      const current = await readGameDesign(workspace, documentId);
      if (!current) throw new GameDesignError("Document not found", 404);
      if (current.revision !== expected) throw new GameDesignError("The document changed. Review the latest version before saving.", 409);
      if (current.document.id !== document.id) throw new GameDesignError("The document ID must stay unchanged");
      return writeGameDesign(workspace, document);
    });
  }
  async setMainDocument(id: string, documentId: string) {
    const workspace = this.#project(id).workspacePath;
    await withDesignLock(workspace, async () => {
      if (!await readGameDesign(workspace, documentId)) throw new GameDesignError("Document not found", 404);
      const index = (await readDesignIndex(workspace))!; index.mainDocumentId = documentId;
      await writeJson(workspace, "index.json", index);
    });
  }
  async board(id: string, boardId: string): Promise<DesignBoardDetail> {
    const workspace = this.#project(id).workspacePath;
    if (!(await readDesignIndex(workspace))?.boards.some((board) => board.id === boardId)) throw new GameDesignError("Design board not found", 404);
    const detail = await readDesignBoard(workspace, boardId);
    if (!detail) throw new GameDesignError("Design board data is missing", 409);
    return detail;
  }
  async saveBoard(id: string, board: DesignBoard, expected: string) {
    const workspace = this.#project(id).workspacePath;
    return withDesignLock(workspace, async () => {
      const current = await this.board(id, board.id);
      if (current.revision !== expected) throw new GameDesignError("The board changed. Reload the latest board before saving.", 409);
      const documents = (await readDesignIndex(workspace))!.documents;
      if (board.nodes.some((node) => node.type === "document" && !documents.some((document) => document.id === node.data.documentId))) throw new GameDesignError("Document reference not found", 404);
      return writeDesignBoard(workspace, board);
    });
  }
  async changeBoards(id: string, action: { type: "create"; name: string } | { type: "rename" | "delete" | "move"; boardId: string; name?: string; direction?: number }) {
    const workspace = this.#project(id).workspacePath;
    return withDesignLock(workspace, async () => {
      const index = await ensureDesignIndex(workspace);
      if (action.type === "create") {
        if (index.boards.length >= 100) throw new GameDesignError("The workspace supports up to 100 boards");
        const board = createDesignBoard(); await writeDesignBoard(workspace, board); index.boards.push({ id: board.id, name: action.name.trim() || "Untitled" });
      } else {
        const position = index.boards.findIndex((board) => board.id === action.boardId);
        if (position < 0) throw new GameDesignError("Design board not found", 404);
        if (action.type === "rename") index.boards[position]!.name = action.name?.trim() || "Untitled";
        if (action.type === "move") { const target = Math.max(0, Math.min(index.boards.length - 1, position + (action.direction === -1 ? -1 : 1))); [index.boards[position], index.boards[target]] = [index.boards[target]!, index.boards[position]!]; }
        if (action.type === "delete") { if (index.boards.length === 1) throw new GameDesignError("Keep at least one board", 409); index.boards.splice(position, 1); }
      }
      await writeJson(workspace, "index.json", index);
      if (action.type === "delete") await rm(await designPath(workspace, `boards/${validId(action.boardId)}.json`), { force: true });
      return index;
    });
  }
  async insertAsset(id: string, documentId: string, assetId: string): Promise<GameDesignDetail> {
    const workspace = this.#project(id).workspacePath;
    const { asset, absolutePath } = await this.library.content(assetId);
    if (asset.mediaType !== "image") throw new GameDesignError("Choose an image asset");
    const extension = path.extname(absolutePath);
    const file = await this.projects.addGeneratedAsset(id, `design-${assetId}${extension}`, await readFile(absolutePath), { libraryAssetId: assetId });
    return withDesignLock(workspace, async () => {
      const detail = await readGameDesign(workspace, documentId);
      if (!detail) throw new GameDesignError("Document not found", 404);
      const label = asset.name.replace(/[\[\]\n]/g, "");
      return writeGameDesign(workspace, { ...detail.document, markdown: `${detail.document.markdown.trimEnd()}\n\n![${label}](../../${file})\n` });
    });
  }
  async #loadJobs(id: string): Promise<StoredJob[]> {
    if (this.#jobs.has(id)) return this.#jobs.get(id)!;
    let jobs: StoredJob[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(await designPath(this.#project(id).workspacePath, "jobs.json"), "utf8"));
      if (!Array.isArray(value) || value.length > 1000 || value.some((job) => !job || typeof job.id !== "string" || job.context?.projectId !== id || typeof job.context?.boardId !== "string" || typeof job.context?.nodeId !== "string" || !["running", "succeeded", "failed", "cancelled"].includes(job.status))) throw new GameDesignError("Invalid generation history");
      jobs = value.map((job) => job.status === "running" ? { ...job, status: "cancelled", error: "Generation was interrupted. Retry to generate again." } : job);
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    this.#jobs.set(id, jobs); await this.#saveJobs(id); return jobs;
  }
  #saveJobs(id: string) { return writeJson(this.#project(id).workspacePath, "jobs.json", this.#jobs.get(id) ?? []); }
  async jobs(id: string): Promise<ToolJob[]> { return withDesignLock(this.#project(id).workspacePath, async () => (await this.#loadJobs(id)).map(({ input: _input, ...job }) => structuredClone(job))); }
  async start(id: string, boardId: string, nodeId: string, toolId: ToolId, input: RunToolRequest): Promise<ToolJob> {
    const workspace = this.#project(id).workspacePath;
    const job = await withDesignLock(workspace, async () => {
      if (this.#closed) throw new GameDesignError("Generation is shutting down", 503);
      const node = (await this.board(id, boardId)).board.nodes.find((node) => node.id === nodeId);
      if (!node || ({ "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d" } as Record<string, string>)[toolId] !== node.type) throw new GameDesignError("Generation node not found", 404);
      const jobs = await this.#loadJobs(id);
      if (jobs.some((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId && job.status === "running")) throw new GameDesignError("This node is already generating", 409);
      const job: StoredJob = { id: randomUUID(), toolId, createdAt: new Date().toISOString(), status: "running", title: "prompt" in input ? input.prompt.slice(0, 200) : "Model 3D", context: { projectId: id, boardId, nodeId }, input: structuredClone(input) };
      if (jobs.filter((job) => job.status === "running").length >= 20) throw new GameDesignError("Too many active generation jobs", 409);
      this.#jobs.set(id, [job, ...jobs.filter((job) => job.status === "running"), ...jobs.filter((job) => job.status !== "running").slice(0, 80)]); await this.#saveJobs(id); return job;
    });
    const controller = new AbortController(); this.#controllers.set(job.id, controller);
    const execution = this.#execute(id, job, controller); this.#executions.add(execution);
    void execution.finally(() => this.#executions.delete(execution));
    const { input: _input, ...publicJob } = job; return structuredClone(publicJob);
  }
  async #execute(id: string, job: StoredJob, controller: AbortController) {
    try {
      const run = await this.tools.run(job.toolId, job.input!, controller.signal); controller.signal.throwIfAborted();
      const output = run.files[0];
      if (!output?.assetId) throw new GameDesignError("Generation returned no Library asset", 502);
      await withDesignLock(this.#project(id).workspacePath, async () => {
        if (controller.signal.aborted) return;
        const workspace = this.#project(id).workspacePath, boardId = job.context!.boardId!;
        if ((await readDesignIndex(workspace))?.boards.some((board) => board.id === boardId)) {
          const detail = await readDesignBoard(workspace, boardId), node = detail?.board.nodes.find((node) => node.id === job.context!.nodeId);
          if (detail && node && ["image", "video", "model-3d", "animate-3d"].includes(node.type)) { Object.assign(node.data, { assetId: output.assetId }); await writeDesignBoard(workspace, detail.board); }
        }
        job.run = run; job.status = "succeeded"; delete job.input; await this.#saveJobs(id);
      });
      await this.tools.removeRun(run.id).catch(() => {});
    } catch (cause) {
      job.status = controller.signal.aborted ? "cancelled" : "failed"; job.error = cause instanceof Error ? cause.message : String(cause);
      try { await withDesignLock(this.#project(id).workspacePath, () => this.#saveJobs(id)); } catch { /* Removed projects have no history to update. */ }
    } finally { this.#controllers.delete(job.id); }
  }
  async cancel(id: string, jobId: string): Promise<ToolJob> {
    return withDesignLock(this.#project(id).workspacePath, async () => {
      const job = (await this.#loadJobs(id)).find((job) => job.id === jobId);
      if (!job) throw new GameDesignError("Generation job not found", 404);
      if (job.status === "running") { job.status = "cancelled"; job.error = "Generation cancelled"; this.#controllers.get(job.id)?.abort(); await this.#saveJobs(id); }
      const { input: _input, ...result } = job; return structuredClone(result);
    });
  }
  async retry(id: string, jobId: string): Promise<ToolJob> {
    const job = (await this.#loadJobs(id)).find((job) => job.id === jobId);
    if (!job || !job.input || !["failed", "cancelled"].includes(job.status)) throw new GameDesignError("This job cannot be retried", 409);
    return this.start(id, job.context!.boardId!, job.context!.nodeId, job.toolId, job.input);
  }
  async cancelProject(id: string) { for (const job of this.#jobs.get(id) ?? []) if (job.status === "running") await this.cancel(id, job.id); this.#jobs.delete(id); }
  async close() { this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(); await Promise.allSettled(this.#executions); }
}
