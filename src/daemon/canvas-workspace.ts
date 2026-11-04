import { Compile } from "typebox/schema";
import { canvasDownstream, canvasNodeSourceIds, canvasUpstreamKeys } from "../shared/canvas-chains.js";
import { tableValidator, layoutValidator } from "../shared/canvas-validators.js";
import { audioSettings } from "../shared/audio.js";
import { CANVAS_TABLE_SCHEMA, createCanvasTable, isCanvasTable, canvasTablePath, type CanvasTable, type CanvasTableDetail } from "../shared/canvas-table.js";
import { createHash, randomUUID } from "node:crypto";
import { applyCanvasNodeLayout, canvasNodeContent, canvasNodeLayout, contentNodeSizeIssue, isResizableCanvasNodeType } from "../shared/canvas-node-layout.js";
import { resolveVideoMentions } from "../shared/video-references.js";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import type { AssetCanvasNode, ProjectState, PromptImage, RunToolRequest, ToolJob, ToolId } from "../shared/contracts.js";
import { createCanvasBoard, fitCanvasLayout, isCanvasBoard, isCanvasIndex, CANVAS_INDEX_SCHEMA, CANVAS_BOARD_SCHEMA, CANVAS_LAYOUT_SCHEMA, type CanvasBoard, type CanvasBoardDetail, type CanvasWorkspaceDetail, type CanvasWorkspaceIndex } from "../shared/canvas-workspace.js";
import { CANVAS_ASSETS_SCHEMA, canvasNodeAssetIds } from "../shared/canvas-assets.js";
import { combineAssetCanvasPrompt, createAssetCanvasDocument, resolveAssetCanvasAssetId, validateAssetCanvasDocument } from "../shared/asset-canvas.js";
import { canvasImagePresetPrompt } from "../shared/canvas-image-presets.js";
import { resolveContinuousActionPrompt } from "../shared/canvas-character-tools.js";
import { buildModel3DToolRequest } from "../shared/generation-config.js";
import { getWorkspaceMedia } from "./workspace.js";
import { createCanvasDocument, canvasDocumentPath, type CanvasDocumentDetail, type CanvasMarkdownDocument } from "../shared/canvas-document.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";
import { CanvasError, canvasPath, parseCanvasJson, readCanvasFile, writeCanvasFile as writeAtomic, writeCanvasJson as writeJson } from "./canvas-files.js";
import { canvasAssetCatalog, canvasLibraryAsset, ensureCanvasAssets, inspectCanvasAssets, readCanvasAssets } from "./canvas-assets.js";
import { sameJson } from "../shared/same-json.js";
export { CanvasError } from "./canvas-files.js";

const boardFileValidator = Compile(CANVAS_BOARD_SCHEMA);
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
- index.json lists boards, documents, optional tables, and the main document. Keep IDs stable; names and titles may change.
- boards/<id>.json contains nodes and their content. Every node may have a title and a description of its purpose. Document bodies live in documents/<id>.md, referenced by documentId. Table data lives in tables/<id>.json, referenced by tableId; register tables in index.json. Keep row/column IDs stable and match cells to their column types.
- Give nodes meaningful titles. Descriptions explain their intended role; do not describe unseen image pixels as verified facts.
- For game work, identify reference mockups and production assets in node titles/descriptions. Record production assets' intended gameplay use in the design document; reference mockups do not fulfill those requirements.
- editor/<board-id>.json stores positions, zoom, and width/height for text, document, table, and group nodes only; media and generation nodes size to their content. fitView requests a one-time fit when a remixed board is first opened; the editor clears it after saving the new viewport. New nodes are placed automatically; layout edits are only needed when the user asks to arrange the canvas.
- Group nodes have data.name and a required width/height in editor layout. A node may have parentId pointing at a group; its position is relative to that group. Parents must exist and cannot form cycles. Removing a group in the editor removes its descendants; ungrouping preserves them.
- assets.json maps asset IDs to names, workspace-relative paths, optional descriptions and generation prompts. Use the same ID for the same asset across boards. References with type "library" resolve through this manifest. libraryAssetId records provenance; local files remain usable without the Library.
- Read actual image files with read when judging their appearance. A name, description, or generation prompt is not proof of what the image shows.
- promptSource references a text or document node. Text and document nodes accept references to text, document, image, or image asset nodes as AI source material. images, references, and source declare dependencies; their canvas lines are derived. Do not duplicate these relationships in edges.
- Speech, sound-effect, music, and audio-scene nodes use the shared audio model contract. Audio references use stable AudioN/ImageN IDs with a node or Library source; mention audio as @AudioN. Use up to three short audio clips, one image, or a Speaker ID as separate modes. Subtitles and generation metadata are saved beside the audio. Keep provider-specific credentials out of canvas files; select models by provider/id and only use options advertised by that model's capabilities.
- To add local media, register its workspace-relative path in assets.json and reference its ID from an asset node or an existing generation node.
- A file node points at any other project file by its project-relative path (data.path), such as a source file, font, archive or editor project; with directory: true it points at a folder whose structure matters, such as an asset pack. Files and folders imported on the canvas live under assets/files/. Read or use the files themselves; update the path if you move them.
- Do not trigger generation merely by editing a prompt or adding a reference. A game-creation request includes its needed media unless the user narrows the scope. Use generate_canvas_media with the saved boardId and nodeIds for generation; it uses the node settings and shared generation history.
- A plugin node (type "plugin") runs a project plugin's code: data.node names it as publisher/name:node, data.params holds its settings, data.inputs maps each input ID to node or Library references, and its output is data.assetId or data.text. Keep data.node as it is, and generate it with generate_canvas_media like other generation nodes.
- Removing a node or board keeps its documents, tables, and assets. Remove references to a deleted node from the same board.
- An editor-context block identifies the current board and selected nodes. Read the referenced files before editing, and preserve other user changes.
`;
const CANVAS_README = `# Canvas workspace

The canvas edits ordinary project files. Documents are Markdown and media files are available directly under assets/ in the project. Other files imported on the canvas are kept under assets/files/ and shown as file nodes.

| File | Content |
| --- | --- |
| index.json | Board IDs/names, document and table IDs/titles, and mainDocumentId |
| boards/<id>.json | Node IDs, optional titles/descriptions, content and references |
| documents/<id>.md | Canonical document body |
| tables/<id>.json | Typed columns and rows with stable IDs; cells keyed by column ID |
| assets.json | Asset IDs, names, project-relative file paths, descriptions and generation prompts |
| editor/<id>.json | Positions, text/document/table node dimensions and canvas viewport; missing node positions are filled automatically |
| schemas/ | Exact persisted file contracts |
| jobs.json | Generation history managed by the application |

Read AGENTS.md for editing conventions. Asset paths are relative to the project root; Markdown image links are relative to the document file. Node IDs need only be unique within their board; asset, document and table IDs are shared across the canvas workspace.
`;
export async function ensureCanvasContract(workspace: string, replaceReadme = false): Promise<void> {
  for (const [name, value] of [["index", CANVAS_INDEX_SCHEMA], ["board", CANVAS_BOARD_SCHEMA], ["layout", CANVAS_LAYOUT_SCHEMA], ["assets", CANVAS_ASSETS_SCHEMA], ["table", CANVAS_TABLE_SCHEMA]] as const) {
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
    throw new CanvasError("This project uses the previous canvas format. Stop OhMyGame and run scripts/migrate-canvas-workspaces.ts from an OhMyGame source checkout against its data directory (see docs/canvas-agent.md) before opening it.", 409);
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
export async function readCanvasTable(workspace: string, tableId: string): Promise<CanvasTableDetail | undefined> {
  validId(tableId);
  if (!(await readCanvasIndex(workspace))?.tables?.some((table) => table.id === tableId)) return undefined;
  return readTableFile(workspace, tableId);
}
async function readTableFile(workspace: string, tableId: string): Promise<CanvasTableDetail> {
  const file = `tables/${tableId}.json`, text = await readCanvasFile(workspace, file, 4 * 1024 * 1024);
  if (text === undefined) throw new CanvasError(`canvas/${file}: table file is missing`, 409);
  const table = parseCanvasJson<CanvasTable>(text, file, CANVAS_TABLE_SCHEMA, tableValidator);
  if (!isCanvasTable(table) || table.id !== tableId) throw new CanvasError(`canvas/${file}: invalid table IDs or cell types`);
  return { table, revision: revision(text) };
}
async function writeCanvasTable(workspace: string, table: CanvasTable): Promise<CanvasTableDetail> {
  if (!isCanvasTable(table)) throw new CanvasError("Invalid canvas table");
  const text = `${JSON.stringify(table, null, 2)}\n`;
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new CanvasError("Canvas table is too large");
  const index = await ensureCanvasIndex(workspace);
  const tables = index.tables ??= [];
  const entry = tables.find((entry) => entry.id === table.id);
  if (!entry && tables.length >= 200) throw new CanvasError("The workspace supports up to 200 tables");
  await writeAtomic(workspace, `tables/${validId(table.id)}.json`, text);
  if (entry) entry.title = table.title;
  else tables.push({ id: table.id, title: table.title });
  await writeJson(workspace, "index.json", index);
  return { table, revision: revision(text) };
}
export async function readCanvasBoard(workspace: string, id: string): Promise<CanvasBoardDetail | undefined> {
  return (await inspectCanvasBoard(workspace, id))?.detail;
}
/** Reads a board and lists tolerated problems that canvas_check reports but the editor ignores. */
export async function inspectCanvasBoard(workspace: string, id: string): Promise<{ detail: CanvasBoardDetail; issues: string[] } | undefined> {
  const name = `boards/${validId(id)}.json`, text = await readCanvasFile(workspace, name);
  if (text === undefined) return undefined;
  const raw = parseCanvasJson<Omit<CanvasBoard, "editorLayout">>(text, name, CANVAS_BOARD_SCHEMA, boardFileValidator);
  const layoutName = `editor/${id}.json`, layoutText = await readCanvasFile(workspace, layoutName);
  const layout = layoutText === undefined ? createAssetCanvasDocument().editorLayout : parseCanvasJson<CanvasBoard["editorLayout"]>(layoutText, layoutName, CANVAS_LAYOUT_SCHEMA, layoutValidator);
  const editorLayout = fitCanvasLayout(raw.nodes, layout), issues: string[] = [];
  for (const node of raw.nodes) {
    const { width, height, ...position } = editorLayout.nodes[node.id]!;
    if (isResizableCanvasNodeType(node.type) || (width === undefined && height === undefined)) continue;
    // Older agent edits could size content-sized nodes; ignore the size so those boards still open.
    editorLayout.nodes[node.id] = position;
    issues.push(contentNodeSizeIssue(node));
  }
  const board = { ...raw, editorLayout, nodes: raw.nodes.map((node) => applyCanvasNodeLayout(node, editorLayout.nodes[node.id]!)) };
  // The file schemas were checked above; validate cross-node rules once.
  try { validateAssetCanvasDocument(board); }
  catch (cause) { throw new CanvasError(`canvas/${name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (board.id !== id) throw new CanvasError(`canvas/${name}: board ID does not match its file name`);
  return { detail: { board, revision: revision([text, layoutText ?? ""]) }, issues };
}
/** A board as its file stores it, without the editor's layout and view. */
function canvasBoardContent({ editorLayout: _editorLayout, ...content }: CanvasBoard) {
  return { ...content, nodes: content.nodes.map(canvasNodeContent) };
}
async function writeCanvasBoard(workspace: string, board: CanvasBoard): Promise<CanvasBoardDetail> {
  if (!isCanvasBoard(board)) throw new CanvasError("Invalid canvas board");
  const { editorLayout } = board;
  const persisted = canvasBoardContent(board);
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
      const removedImages = new RegExp(`!\\[[^\\]\\n]*\\]\\((?:${[...removedLinks].map((link) => link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\)`, "g");
      for (const detail of await readCanvasDocuments(workspace, index)) {
        const markdown = detail.document.markdown.replace(removedImages, "");
        if (markdown !== detail.document.markdown) await writeAtomic(workspace, `documents/${detail.document.id}.md`, markdown);
      }
    }
    for (const detail of boards) {
      if (!canvasNodeAssetIds(detail.board.nodes).some((assetId) => ids.has(assetId))) continue;
      const removed = new Set(detail.board.nodes.filter((node) => node.type === "asset" && ids.has(node.data.assetId)).map((node) => node.id));
      detail.board.nodes = detail.board.nodes.filter((node) => !removed.has(node.id)).map((node) => {
        const data = { ...node.data };
        if ("assetId" in data && data.assetId && ids.has(data.assetId)) delete data.assetId;
        if ("audioReferences" in data) data.audioReferences = data.audioReferences?.filter((reference) => reference.source.type === "library" ? !ids.has(reference.source.assetId) : !removed.has(reference.source.nodeId));
        if ("images" in data) data.images = data.images.filter((reference) => reference.type === "library" ? !ids.has(reference.assetId) : !removed.has(reference.nodeId));
        if ("references" in data && data.references) data.references = data.references.filter((reference) => reference.type === "library" ? !ids.has(reference.assetId) : !removed.has(reference.nodeId));
        if ("source" in data && data.source && (data.source.type === "library" ? ids.has(data.source.assetId) : removed.has(data.source.nodeId))) delete data.source;
        if (node.type === "plugin") (data as typeof node.data).inputs = Object.fromEntries(Object.entries(node.data.inputs).map(([key, references]) => [key, references.filter((reference) => reference.type === "library" ? !ids.has(reference.assetId) : !removed.has(reference.nodeId))]));
        return { ...node, data } as AssetCanvasNode;
      });
      detail.board.edges = detail.board.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
      detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, canvasNodeLayout(node)]));
      await writeCanvasBoard(workspace, detail.board);
    }
    if ([...ids].some((assetId) => manifest.assets[assetId])) {
      for (const assetId of ids) delete manifest.assets[assetId];
      await writeJson(workspace, "assets.json", manifest);
    }
  });
}
type StoredJob = ToolJob & { input?: RunToolRequest; recoveryId?: string; inputRevision?: string; pluginOutput?: string };

/** A plugin canvas node's input, as its code gets it. */
export type CanvasPluginInput =
  | { type: "image" | "audio" | "video" | "model"; path: string; contentType: string }
  | { type: "text"; text: string };
export interface CanvasPluginRequest {
  /** `publisher/name:node`. */
  node: string;
  params: Record<string, string | number | boolean>;
  inputs: Record<string, CanvasPluginInput[]>;
}
/** Runs plugins' canvas nodes; the output is a Library asset or text. */
export interface CanvasPluginRunner {
  run(project: ProjectState, request: CanvasPluginRequest, signal: AbortSignal): Promise<{ assetId: string } | { text: string }>;
}
const publicJob = ({ input: _input, recoveryId: _recoveryId, inputRevision: _inputRevision, pluginOutput: _pluginOutput, ...job }: StoredJob): ToolJob => structuredClone(job);
/** How a reusing generation request was satisfied without starting another paid job. */
export type CanvasGenerationReuse = "running" | "output";
/** The nodes the daemon runs, and the tool each runs as. */
const NODE_TOOLS = { image: "generate-image", video: "generate-video", "model-3d": "image-to-3d", "animate-3d": "animate-3d", speech: "generate-speech", "sound-effect": "generate-sound-effect", music: "generate-music", "audio-scene": "generate-audio", plugin: "plugin-node" } as const satisfies Partial<Record<AssetCanvasNode["type"], ToolJob["toolId"]>>;
/** What a run of a node reads from the board: its own data and what each of its sources gives. */
function nodeReads(board: CanvasBoard, nodeId: string): string | undefined {
  const node = board.nodes.find((candidate) => candidate.id === nodeId);
  return node && JSON.stringify([node.type, node.data, canvasUpstreamKeys(board.nodes, node)]);
}

export class CanvasStore {
  readonly #executions = new Map<string, Set<Promise<void>>>();

  isProjectBusy(id: string): boolean { return Boolean(this.#executions.get(id)?.size); }
  async waitForProject(id: string): Promise<void> {
    while (this.#executions.get(id)?.size) await Promise.allSettled([...this.#executions.get(id)!]);
  }
  readonly #jobs = new Map<string, StoredJob[]>();
  readonly #controllers = new Map<string, AbortController>();
  #closed = false;
  constructor(private readonly projects: ProjectManager, private readonly library: AssetLibrary, private readonly tools: ToolRunner, private readonly plugins?: CanvasPluginRunner) {}
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
      const index = await ensureCanvasIndex(workspace);
      const tableIssues: NonNullable<CanvasWorkspaceDetail["tableIssues"]> = [];
      const tables = (await Promise.all((index.tables ?? []).map(async (entry) => {
        try { const detail = await readTableFile(workspace, entry.id); return { ...detail.table, revision: detail.revision, source: canvasTablePath(entry.id) }; }
        catch (cause) { tableIssues.push({ ...entry, source: canvasTablePath(entry.id), message: cause instanceof Error ? cause.message : String(cause) }); return undefined; }
      }))).filter((table) => table !== undefined);
      const documentIssues: NonNullable<CanvasWorkspaceDetail["documentIssues"]> = [];
      const documents = (await Promise.all(index.documents.map(async (entry) => {
        try { return await readDocumentEntry(workspace, entry); }
        catch (cause) {
          documentIssues.push({ ...entry, source: canvasDocumentPath(entry.id), message: cause instanceof Error ? cause.message : String(cause) });
          return undefined;
        }
      }))).filter((document) => document !== undefined);
      await ensureCanvasContract(workspace);
      const assets = await inspectCanvasAssets(workspace, await readCanvasAssets(workspace));
      // File revisions cover the large table cells and Markdown bodies. Include index titles,
      // ordering, asset availability and read errors so an external edit is always visible.
      const workspaceRevision = revision([index, assets, tables.map((table) => table.revision),
        documents.map((doc) => doc.revision), tableIssues, documentIssues]);
      return { ...index, ...assets, revision: workspaceRevision, tables, tableIssues, documentIssues, documents: documents.map((detail) => ({ ...detail.document, revision: detail.revision, source: canvasDocumentPath(detail.document.id), main: detail.document.id === index.mainDocumentId })) };
    });
  }
  async createDocument(id: string, title: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, () => writeCanvasDocument(workspace, createCanvasDocument(title.trim() || "Untitled document"), project.type !== "asset-canvas"));
  }
  async save(id: string, document: CanvasMarkdownDocument, expected: string, documentId?: string) {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await readCanvasDocument(workspace, documentId);
      if (!current) throw new CanvasError("Document not found", 404);
      if (current.revision !== expected) throw new CanvasError("The document changed. Review the latest version before saving.", 409);
      if (current.document.id !== document.id) throw new CanvasError("The document ID must stay unchanged");
      return writeCanvasDocument(workspace, document, project.type !== "asset-canvas");
    });
  }
  async table(id: string, tableId: string): Promise<CanvasTableDetail> {
    const detail = await readCanvasTable(this.#project(id).workspacePath, tableId);
    if (!detail) throw new CanvasError("Table not found", 404);
    return detail;
  }
  async createTable(id: string, title: string): Promise<CanvasTableDetail> {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, () => writeCanvasTable(workspace, createCanvasTable(title)));
  }
  async saveTable(id: string, table: CanvasTable, expected: string): Promise<CanvasTableDetail> {
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const current = await this.table(id, table.id);
      if (current.revision !== expected) throw new CanvasError("The table changed. Review the latest version before saving.", 409);
      return writeCanvasTable(workspace, table);
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
      const index = (await readCanvasIndex(workspace))!;
      const documents = index.documents;
      const existingTables = new Set(current.board.nodes.flatMap((node) => node.type === "table" ? [node.data.tableId] : []));
      if (board.nodes.some((node) => node.type === "table" && !existingTables.has(node.data.tableId) && !index.tables?.some((table) => table.id === node.data.tableId))) throw new CanvasError("Table reference not found", 404);
      const existingDocuments = new Set(current.board.nodes.flatMap((node) => node.type === "document" ? [node.data.documentId] : []));
      if (board.nodes.some((node) => node.type === "document" && !existingDocuments.has(node.data.documentId) && !documents.some((document) => document.id === node.data.documentId))) throw new CanvasError("Document reference not found", 404);
      await ensureCanvasAssets(project, this.projects, this.library, canvasNodeAssetIds(board.nodes), canvasNodeAssetIds(current.board.nodes));
      const detail = await writeCanvasBoard(workspace, board);
      // Moving the view is not editing the project.
      if (!sameJson(canvasBoardContent(current.board), canvasBoardContent(board))) await this.projects.touch(id);
      return detail;
    });
  }
  async changeBoards(id: string, action: { type: "create"; name: string } | { type: "rename" | "delete" | "move"; boardId: string; name?: string; direction?: number }) {
    const project = this.#project(id), workspace = project.workspacePath;
    // Asset Canvas shows one board; templates only rename it.
    if (project.type === "asset-canvas" && action.type !== "rename") throw new CanvasError("Asset Canvas uses one default board", 409);
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
    const project = this.#project(id), workspace = project.workspacePath;
    return withCanvasLock(workspace, async () => {
      const manifest = await ensureCanvasAssets(project, this.projects, this.library, [assetId]);
      const asset = (await canvasAssetCatalog(workspace, manifest, [assetId]))[0]!;
      if (asset.mediaType !== "image") throw new CanvasError("Choose an image asset");
      const detail = await readCanvasDocument(workspace, documentId);
      if (!detail) throw new CanvasError("Document not found", 404);
      const label = asset.name.replace(/[[\]\n]/g, "");
      const link = asset.path.split("/").map(encodeURIComponent).join("/");
      const saved = await writeCanvasDocument(workspace, { ...detail.document, markdown: `${detail.document.markdown.trimEnd()}\n\n![${label}](../../${link})\n` }, project.type !== "asset-canvas");
      if (asset.libraryAssetId && this.library.get(asset.libraryAssetId)) await this.library.save(asset.libraryAssetId);
      return saved;
    });
  }
  async #loadJobs(id: string): Promise<StoredJob[]> {
    if (this.#jobs.has(id)) return this.#jobs.get(id)!;
    const project = this.#project(id);
    await ensureCanvasIndex(project.workspacePath);
    let jobs: StoredJob[] = [];
    try {
      const value: unknown = JSON.parse(await readFile(await canvasPath(this.#project(id).workspacePath, "jobs.json"), "utf8"));
      if (!Array.isArray(value) || value.length > 1000 || value.some((job) => !job || typeof job.id !== "string" || job.context?.projectId !== id || typeof job.context?.boardId !== "string" || typeof job.context?.nodeId !== "string" || !["running", "succeeded", "failed", "cancelled"].includes(job.status))) throw new CanvasError("Invalid generation history");
      jobs = value.map((job) => job.status === "running" ? { ...job, status: "cancelled", error: "Generation was interrupted. Retry to resume a submitted 3D task." } : job);
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    this.#jobs.set(id, jobs); await this.#saveJobs(id); return jobs;
  }
  #saveJobs(id: string) { return writeJson(this.#project(id).workspacePath, "jobs.json", this.#jobs.get(id) ?? []); }
  async jobs(id: string): Promise<ToolJob[]> { return withCanvasLock(this.#project(id).workspacePath, async () => (await this.#loadJobs(id)).map(publicJob)); }
  async start(id: string, boardId: string, nodeId: string, toolId: ToolId, input: RunToolRequest, expectedReads?: string, recoveryId?: string, reuse = false): Promise<ToolJob & { reused?: CanvasGenerationReuse }> {
    const workspace = this.#project(id).workspacePath;
    const read = await this.board(id, boardId), reading = read.board.nodes.find((node) => node.id === nodeId);
    const upstream = reading ? await this.#upstream(id, read.board, reading) : {};
    const started = await withCanvasLock(workspace, async () => {
      if (this.#closed) throw new CanvasError("Generation is shutting down", 503);
      const detail = await this.board(id, boardId);
      if (expectedReads && nodeReads(detail.board, nodeId) !== expectedReads) throw new CanvasError("The node settings changed before generation. Read the current board and try again.", 409);
      const node = detail.board.nodes.find((node) => node.id === nodeId);
      const expectedNodeType = ({ "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d", "generate-speech": "speech", "generate-sound-effect": "sound-effect", "generate-music": "music", "generate-audio": "audio-scene" } as Partial<Record<ToolId, string>>)[toolId];
      if (!node || !expectedNodeType || expectedNodeType !== node.type) throw new CanvasError("Generation node not found", 404);
      const jobs = await this.#loadJobs(id);
      const nodeJobs = jobs.filter((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId);
      const running = nodeJobs.find((job) => job.status === "running");
      if (running && reuse) return { reused: "running" as const, job: running };
      if (running) throw new CanvasError("This node is already generating", 409);
      const resolved = await this.tools.prepare(toolId, input, id);
      const inputRevision = revision(resolved), latest = nodeJobs.find((job) => job.status !== "cancelled");
      const currentAssetId = (node.data as { assetId?: string }).assetId;
      if (reuse && latest?.status === "succeeded" && latest.inputRevision === inputRevision && currentAssetId && latest.run?.files[0]?.assetId === currentAssetId) return { reused: "output" as const, job: latest };
      const prepared = structuredClone(resolved);
      const model = "imageModel" in resolved ? resolved.imageModel : "model" in resolved ? resolved.model : undefined;
      if (toolId === "generate-video" && "references" in prepared) for (const reference of prepared.references ?? []) reference.assetId = await canvasLibraryAsset(this.#project(id), this.library, reference.assetId);
      if (toolId === "animate-3d" && "assetId" in prepared) prepared.assetId = await canvasLibraryAsset(this.#project(id), this.library, prepared.assetId);
      if (toolId === "image-to-3d" && "sourceAssetId" in prepared && prepared.sourceAssetId) prepared.sourceAssetId = await canvasLibraryAsset(this.#project(id), this.library, prepared.sourceAssetId);
      const job: StoredJob = { recoveryId: recoveryId ?? randomUUID(), inputRevision, id: randomUUID(), toolId, createdAt: new Date().toISOString(), status: "running", title: "prompt" in input ? (input.prompt ?? "Model 3D").slice(0, 200) : "text" in input ? (input.text.trim().slice(0, 200) || "Speech") : "Model 3D", context: { projectId: id, boardId, nodeId }, upstream, ...(model ? { model } : {}), input: structuredClone(resolved) };
      if (jobs.filter((job) => job.status === "running").length >= 20) throw new CanvasError("Too many active generation jobs", 409);
      this.#jobs.set(id, [job, ...jobs.filter((job) => job.status === "running"), ...jobs.filter((job) => job.status !== "running").slice(0, 80)]); await this.#saveJobs(id); return { job, prepared };
    });
    if ("reused" in started) return { ...publicJob(started.job), reused: started.reused };
    const { job, prepared } = started;
    const controller = new AbortController(); this.#controllers.set(job.id, controller);
    this.#track(id, this.#execute(id, job, prepared, controller));
    return publicJob(job);
  }
  /** With `reuse`, an agent request follows a run already in progress, or returns the node's current output when it came from identical settings, instead of paying for another generation. */
  async generateNode(id: string, boardId: string, nodeId: string, reuse = false): Promise<ToolJob & { reused?: CanvasGenerationReuse }> {
    const project = this.#project(id), { board } = await this.board(id, boardId);
    const node = board.nodes.find((node) => node.id === nodeId);
    if (node?.type === "plugin") return this.#startPlugin(id, boardId, nodeId, reuse);
    // The request is built from this read; edits elsewhere on the board, such as another node's output, don't stop it.
    const revision = nodeReads(board, nodeId);
    if (!node || !["image", "video", "model-3d", "animate-3d", "speech", "sound-effect", "music", "audio-scene"].includes(node.type)) throw new CanvasError("Choose a media generation node");
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
      return this.start(id, boardId, nodeId, "animate-3d", { model: node.data.model, options: node.data.options, assetId: assetId(node.data.source), actionIds: node.data.actionIds, heightMeters: node.data.heightMeters }, revision, undefined, reuse);
    }
    if (node.type === "model-3d") {
      const operation = node.data.operation ?? "image";
      if (operation === "image" && !node.data.images.length) throw new CanvasError("Add a reference image before generating");
      const linked = board.nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
      const text = linked?.type === "text" ? linked.data.text : linked?.type === "document" ? (await this.read(id, linked.data.documentId))?.document.markdown : undefined;
      const prompt = combineAssetCanvasPrompt(text, node.data.prompt ?? "");
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
      return this.start(id, boardId, nodeId, "image-to-3d", { ...buildModel3DToolRequest(node.data, images, operation), operation, ...(prompt ? { prompt } : {}), ...(node.data.source ? { sourceAssetId: assetId(node.data.source) } : {}), ...(node.data.options ? { options: node.data.options } : {}) }, revision, undefined, reuse);
    }
    // Music and Audio creation offer no audio settings, so saved ones are not sent.
    const audio = node.type === "speech" || node.type === "sound-effect" ? audioSettings(node.data) : {};
    if (node.type === "speech") {
      const linked = board.nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
      const linkedText = linked?.type === "text" ? linked.data.text : linked?.type === "document" ? (await this.read(id, linked.data.documentId))?.document.markdown : undefined;
      const text = combineAssetCanvasPrompt(linkedText, node.data.text);
      if (!text) throw new CanvasError("Add text to synthesize before generating");
      return this.start(id, boardId, nodeId, "generate-speech", { ...audio, text, ...(node.data.model ? { model: node.data.model } : {}), ...(node.data.voiceId ? { voiceId: node.data.voiceId } : {}), ...(node.data.speed !== undefined ? { speed: node.data.speed } : {}) }, revision, undefined, reuse);
    }
    if (node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene") {
      const linked = board.nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
      const linkedText = linked?.type === "text" ? linked.data.text : linked?.type === "document" ? (await this.read(id, linked.data.documentId))?.document.markdown : undefined;
      const prompt = combineAssetCanvasPrompt(linkedText, node.data.prompt);
      if (!prompt) throw new CanvasError(`Add a prompt before generating ${node.type === "music" ? "music" : "a sound effect"}`);
      if (node.type === "sound-effect") return this.start(id, boardId, nodeId, "generate-sound-effect", {
        ...audio, prompt,
        ...(node.data.model ? { model: node.data.model } : {}),
        ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
        ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
        ...(node.data.negativePrompt ? { negativePrompt: node.data.negativePrompt } : {}),
      }, revision, undefined, reuse);
      if (node.type === "audio-scene") return this.start(id, boardId, nodeId, "generate-audio", { ...audio, prompt, ...(node.data.model ? { model: node.data.model } : {}), ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}) }, revision, undefined, reuse);
      return this.start(id, boardId, nodeId, "generate-music", { ...audio,
        prompt,
        ...(node.data.model ? { model: node.data.model } : {}),
        instrumental: node.data.instrumental,
        ...(node.data.lyrics ? { lyrics: node.data.lyrics } : {}),
        ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
        ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      }, revision, undefined, reuse);
    }
    if (node.type !== "image" && node.type !== "video") throw new CanvasError("Unsupported generation node");
    const linked = board.nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
    const text = linked?.type === "text" ? linked.data.text : linked?.type === "document" ? (await this.read(id, linked.data.documentId))?.document.markdown : undefined;
    const prompt = combineAssetCanvasPrompt(text, node.data.prompt);
    if (!prompt) throw new CanvasError("Add a prompt before generating");
    if (node.type === "image") {
      let imagePrompt = prompt;
      if (node.data.presetId === "continuous-sequence" && node.data.actionDescription !== undefined) {
        try { imagePrompt = resolveContinuousActionPrompt(prompt, node.data.actionDescription); }
        catch (cause) { throw new CanvasError(cause instanceof Error ? cause.message : String(cause)); }
      }
      if (node.data.presetId === "continuous-sequence" && imagePrompt.includes("{USER_ACTION}")) throw new CanvasError("Enter an action description before generating");
      if (node.data.quickReskinMode === "person-clothing" && node.data.images.length !== 2) throw new CanvasError("Quick reskin requires a person image and a clothing image");
      if (node.data.presetId === "quick-reskin" && !node.data.quickReskinMode && node.data.images.length !== 1) throw new CanvasError("Quick reskin requires one source image");
      let pixelStyle = node.data.pixelStyle;
      let parentId = node.parentId;
      const visited = new Set<string>();
      while (!pixelStyle && parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = board.nodes.find((candidate) => candidate.id === parentId);
        if (parent?.type !== "group") break;
        pixelStyle = parent.data.pixelStyle;
        parentId = parent.parentId;
      }
      return this.start(id, boardId, nodeId, "generate-image", { prompt: node.data.promptExpanded ? imagePrompt : canvasImagePresetPrompt(node.data.presetId, imagePrompt, node.data.materialStyle, node.data.images.length, pixelStyle ?? "classic"), resolution: node.data.resolution, aspectRatio: node.data.aspectRatio, ...(node.data.model ? { imageModel: node.data.model } : {}), ...(node.data.effectBasePrompt ? { transparentBackground: true } : {}), images: await Promise.all(node.data.images.map(image)) }, revision, undefined, reuse);
    }
    const referenceIds = node.data.references.map(assetId);
    const catalog = await canvasAssetCatalog(project.workspacePath, manifest, referenceIds);
    const references = referenceIds.map((id) => {
      const asset = catalog.find((asset) => asset.id === id)!;
      if (asset.mediaType !== "image") throw new CanvasError("Video generation currently accepts image references only");
      return { type: "image" as const, assetId: id };
    });
    let resolvedPrompt: string;
    try { resolvedPrompt = resolveVideoMentions(prompt, node.data.references, node.data.referenceMentions); }
    catch (cause) { throw new CanvasError(cause instanceof Error ? cause.message : String(cause)); }
    return this.start(id, boardId, nodeId, "generate-video", { prompt: resolvedPrompt, model: node.data.model, resolution: node.data.resolution, aspectRatio: node.data.aspectRatio, duration: node.data.duration, references, ...(node.data.referenceMode ? { referenceMode: node.data.referenceMode } : {}) }, revision, undefined, reuse);
  }
  /**
   * Runs a node again, then each node after it that makes something, in
   * order. Those after it keep their output when what they read didn't
   * change. The first failure stops the rest; one that can't start is
   * recorded as a failed run on its node. Starting from a node that makes
   * nothing, such as a Library image, runs only what comes after it.
   */
  async regenerateFrom(id: string, boardId: string, nodeId: string): Promise<{ nodes: string[]; job: ToolJob & { reused?: CanvasGenerationReuse } }> {
    const { board } = await this.board(id, boardId);
    const start = board.nodes.find((node) => node.id === nodeId);
    if (!start) throw new CanvasError("Node not found", 404);
    const plan = [start, ...canvasDownstream(board.nodes, nodeId)].filter((node) => Object.hasOwn(NODE_TOOLS, node.type) && !(node.type === "image" && node.data.sourceInput));
    if (!plan.length) throw new CanvasError("Nothing here or after it makes anything");
    // The first node that makes something always runs again; the rest reuse what nothing upstream changed.
    const first = await this.generateNode(id, boardId, plan[0]!.id, false);
    const rest = async () => {
      let job: ToolJob = first;
      for (const node of plan.slice(1)) {
        if ((await this.#settled(id, job.id))?.status !== "succeeded" || this.#closed) return;
        try { job = await this.generateNode(id, boardId, node.id, true); }
        catch (cause) { await this.#failed(id, boardId, node, cause instanceof Error ? cause.message : String(cause)); return; }
      }
    };
    this.#track(id, rest());
    return { nodes: plan.map((node) => node.id), job: first };
  }
  /** A job once it has finished, or nothing if it is gone or the store closes first. */
  async #settled(id: string, jobId: string): Promise<ToolJob | undefined> {
    for (;;) {
      const job = (await this.#loadJobs(id)).find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "running") return job;
      if (this.#closed) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  /** Records a run that couldn't start, so its node shows why. */
  async #failed(id: string, boardId: string, node: AssetCanvasNode, error: string): Promise<void> {
    await withCanvasLock(this.#project(id).workspacePath, async () => {
      const jobs = await this.#loadJobs(id);
      const job: StoredJob = { id: randomUUID(), toolId: NODE_TOOLS[node.type as keyof typeof NODE_TOOLS], createdAt: new Date().toISOString(), status: "failed", error, title: (node.title?.trim() || node.type).slice(0, 200), context: { projectId: id, boardId, nodeId: node.id } };
      this.#jobs.set(id, [job, ...jobs.filter((candidate) => candidate.status === "running"), ...jobs.filter((candidate) => candidate.status !== "running").slice(0, 80)]);
      await this.#saveJobs(id);
    }).catch(() => undefined);
  }
  /** What each of a node's sources gives now, to tell later whether its output is out of date. */
  async #upstream(id: string, board: CanvasBoard, node: AssetCanvasNode): Promise<Record<string, string>> {
    const markdown = new Map<string, string>();
    for (const source of board.nodes) if (source.type === "document" && canvasNodeSourceIds(node).includes(source.id) && !markdown.has(source.data.documentId))
      markdown.set(source.data.documentId, (await this.read(id, source.data.documentId))?.document.markdown ?? "");
    return canvasUpstreamKeys(board.nodes, node, (documentId) => markdown.get(documentId));
  }
  /** What a plugin node's code gets, and what identifies it for reuse: asset ids and text, not paths. */
  async #pluginInputs(id: string, board: CanvasBoard, node: Extract<AssetCanvasNode, { type: "plugin" }>) {
    const project = this.#project(id), manifest = await readCanvasAssets(project.workspacePath);
    const inputs: Record<string, CanvasPluginInput[]> = {}, signature: Record<string, string[]> = {};
    for (const [key, references] of Object.entries(node.data.inputs)) {
      inputs[key] = []; signature[key] = [];
      for (const reference of references) {
        const source = reference.type === "node" ? board.nodes.find((candidate) => candidate.id === reference.nodeId) : undefined;
        const text = source?.type === "text" ? source.data.text
          : source?.type === "document" ? (await this.read(id, source.data.documentId))?.document.markdown ?? ""
            : source?.type === "plugin" && source.data.text !== undefined ? source.data.text : undefined;
        if (text !== undefined) {
          inputs[key].push({ type: "text", text }); signature[key].push(`text:${revision(text)}`);
          continue;
        }
        const assetId = resolveAssetCanvasAssetId(board.nodes, reference);
        const asset = assetId ? manifest.assets[assetId] : undefined;
        if (!assetId || !asset) throw new CanvasError("A referenced node has no saved output. Generate it first.");
        const media = await getWorkspaceMedia(project.workspacePath, asset.path);
        inputs[key].push({ type: media.mediaType, path: media.absolutePath, contentType: media.contentType }); signature[key].push(`asset:${assetId}`);
      }
    }
    return { inputs, signature };
  }
  async #startPlugin(id: string, boardId: string, nodeId: string, reuse: boolean): Promise<ToolJob & { reused?: CanvasGenerationReuse }> {
    if (!this.plugins) throw new CanvasError("Plugin nodes can't run here", 409);
    const project = this.#project(id), workspace = project.workspacePath;
    const { board } = await this.board(id, boardId);
    const node = board.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.type !== "plugin") throw new CanvasError("Generation node not found", 404);
    const reads = nodeReads(board, nodeId);
    const { inputs, signature } = await this.#pluginInputs(id, board, node);
    const upstream = await this.#upstream(id, board, node);
    const request: CanvasPluginRequest = { node: node.data.node, params: node.data.params, inputs };
    const inputRevision = revision({ node: node.data.node, params: node.data.params, inputs: signature });
    const output = node.data.assetId ? `asset:${node.data.assetId}` : node.data.text !== undefined ? `text:${revision(node.data.text)}` : undefined;
    const started = await withCanvasLock(workspace, async () => {
      if (this.#closed) throw new CanvasError("Generation is shutting down", 503);
      if (nodeReads((await this.board(id, boardId)).board, nodeId) !== reads) throw new CanvasError("The node settings changed before generation. Read the current board and try again.", 409);
      const jobs = await this.#loadJobs(id);
      const nodeJobs = jobs.filter((job) => job.context?.boardId === boardId && job.context.nodeId === nodeId);
      const running = nodeJobs.find((job) => job.status === "running");
      if (running && reuse) return { reused: "running" as const, job: running };
      if (running) throw new CanvasError("This node is already generating", 409);
      const latest = nodeJobs.find((job) => job.status !== "cancelled");
      if (reuse && latest?.status === "succeeded" && latest.inputRevision === inputRevision && output && latest.pluginOutput === output) return { reused: "output" as const, job: latest };
      if (jobs.filter((job) => job.status === "running").length >= 20) throw new CanvasError("Too many active generation jobs", 409);
      const job: StoredJob = { recoveryId: randomUUID(), inputRevision, id: randomUUID(), toolId: "plugin-node", createdAt: new Date().toISOString(), status: "running", title: (node.title?.trim() || node.data.node).slice(0, 200), context: { projectId: id, boardId, nodeId }, upstream };
      this.#jobs.set(id, [job, ...jobs.filter((job) => job.status === "running"), ...jobs.filter((job) => job.status !== "running").slice(0, 80)]); await this.#saveJobs(id); return { job };
    });
    if ("reused" in started) return { ...publicJob(started.job), reused: started.reused };
    const { job } = started;
    const controller = new AbortController(); this.#controllers.set(job.id, controller);
    this.#track(id, this.#executePlugin(id, job, request, controller));
    return publicJob(job);
  }
  async #executePlugin(id: string, job: StoredJob, request: CanvasPluginRequest, controller: AbortController) {
    try {
      const output = await this.plugins!.run(this.#project(id), request, controller.signal); controller.signal.throwIfAborted();
      await withCanvasLock(this.#project(id).workspacePath, async () => {
        if (controller.signal.aborted) return;
        const project = this.#project(id), workspace = project.workspacePath, boardId = job.context!.boardId!;
        if ("assetId" in output) await ensureCanvasAssets(project, this.projects, this.library, [output.assetId]);
        if ((await readCanvasIndex(workspace))?.boards.some((board) => board.id === boardId)) {
          const detail = await readCanvasBoard(workspace, boardId), node = detail?.board.nodes.find((node) => node.id === job.context!.nodeId);
          if (detail && node?.type === "plugin" && node.data.node === request.node) {
            if ("assetId" in output) { node.data.assetId = output.assetId; delete node.data.text; }
            else { node.data.text = output.text; delete node.data.assetId; }
            await writeCanvasBoard(workspace, detail.board);
          }
        }
        job.pluginOutput = "assetId" in output ? `asset:${output.assetId}` : `text:${revision(output.text)}`;
        job.status = "succeeded"; await this.#saveJobs(id);
      });
    } catch (cause) {
      job.status = controller.signal.aborted ? "cancelled" : "failed"; job.error = cause instanceof Error ? cause.message : String(cause);
      try { await withCanvasLock(this.#project(id).workspacePath, () => this.#saveJobs(id)); } catch { /* Removed projects have no history to update. */ }
    } finally { this.#controllers.delete(job.id); }
  }
  #track(id: string, execution: Promise<void>) {
    let executions = this.#executions.get(id);
    if (!executions) { executions = new Set(); this.#executions.set(id, executions); }
    executions.add(execution);
    void execution.finally(() => {
      executions.delete(execution);
      if (!executions.size) this.#executions.delete(id);
    });
  }
  async #execute(id: string, job: StoredJob, prepared: RunToolRequest, controller: AbortController) {
    try {
      const toolId = job.toolId;
      if (toolId === "plugin-node") throw new CanvasError("Plugin nodes run with their own execution");
      const run = await this.tools.runPrepared(toolId, prepared, controller.signal, { recoveryId: job.recoveryId ?? job.id, projectId: id }); controller.signal.throwIfAborted();
      const output = run.files.find((file) => file.role === "audio") ?? run.files[0];
      if (!output?.assetId) throw new CanvasError("Generation returned no Library asset", 502);
      await withCanvasLock(this.#project(id).workspacePath, async () => {
        if (controller.signal.aborted) return;
        const workspace = this.#project(id).workspacePath, boardId = job.context!.boardId!;
        await ensureCanvasAssets(this.#project(id), this.projects, this.library, [output.assetId!]);
        if ((await readCanvasIndex(workspace))?.boards.some((board) => board.id === boardId)) {
          const detail = await readCanvasBoard(workspace, boardId), node = detail?.board.nodes.find((node) => node.id === job.context!.nodeId);
          const expectedType = ({ "generate-image": "image", "generate-video": "video", "image-to-3d": "model-3d", "animate-3d": "animate-3d", "generate-speech": "speech", "generate-sound-effect": "sound-effect", "generate-music": "music", "generate-audio": "audio-scene" } as Partial<Record<ToolId, string>>)[toolId];
          if (detail && node && expectedType && node.type === expectedType) { Object.assign(node.data, { assetId: output.assetId }); await writeCanvasBoard(workspace, detail.board); }
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
      if (job.status === "running") { job.status = "cancelled"; job.error = job.toolId === "image-to-3d" || job.toolId === "animate-3d" ? "Stopped waiting locally. Retry to resume; the provider task may still be running." : "Generation cancelled"; this.#controllers.get(job.id)?.abort(); await this.#saveJobs(id); }
      return publicJob(job);
    });
  }
  async retry(id: string, jobId: string): Promise<ToolJob> {
    const job = await withCanvasLock(this.#project(id).workspacePath, async () => (await this.#loadJobs(id)).find((job) => job.id === jobId));
    // A plugin node runs again from its current settings and inputs.
    if (job?.toolId === "plugin-node" && ["failed", "cancelled"].includes(job.status)) return this.#startPlugin(id, job.context!.boardId!, job.context!.nodeId, false);
    if (!job || !job.input || job.toolId === "plugin-node" || !["failed", "cancelled"].includes(job.status)) throw new CanvasError("This job cannot be retried", 409);
    return this.start(id, job.context!.boardId!, job.context!.nodeId, job.toolId, job.input, undefined, job.recoveryId ?? job.id);
  }
  async cancelProject(id: string) { for (const job of this.#jobs.get(id) ?? []) if (job.status === "running") await this.cancel(id, job.id); this.#jobs.delete(id); }
  async close() { this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(); await Promise.allSettled([...this.#executions.values()].flatMap((executions) => [...executions])); }
}
