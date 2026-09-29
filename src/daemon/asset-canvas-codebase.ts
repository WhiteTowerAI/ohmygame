import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import type { AssetCanvasDocument, AssetCanvasEditorLayout } from "../shared/contracts.js";
import { ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA, ASSET_CANVAS_SCHEMA } from "../shared/asset-canvas-schema.js";
import { createAssetCanvasDocument, validateAssetCanvasDocument } from "../shared/asset-canvas.js";

export const ASSET_CANVAS_FILE = "canvas.json";
const LAYOUT_FILE = "editor/layout.json";
const CANVAS_SCHEMA_FILE = "schemas/asset-canvas.schema.json";
const LAYOUT_SCHEMA_FILE = "schemas/editor-layout.schema.json";
const writes = new Map<string, Promise<void>>();

const AGENT_INSTRUCTIONS = `# Asset Canvas Project

This workspace is an OhMyGame Asset Canvas. It is not an Interactive Drama runtime.

- \`canvas.json\` contains only Text, Image, Video, Model 3D, and imported Asset nodes.
- \`editor/layout.json\` stores editor-only positions and viewport state.
- Read \`schemas/asset-canvas.schema.json\` before editing canvas data.
- Keep node IDs stable and keep the layout Node IDs exactly synchronized with \`canvas.json\`.
- Edges describe generation references, not game navigation.
- Do not add Playable Nodes, Story nodes, runtime surfaces, or a game loop to this workspace.
`;

export async function readAssetCanvasCodebase(workspacePath: string): Promise<AssetCanvasDocument> {
  return withLock(workspacePath, async () => {
    const [documentValue, layoutValue] = await Promise.all([
      readJson(path.join(workspacePath, ASSET_CANVAS_FILE)),
      readJson(path.join(workspacePath, LAYOUT_FILE)),
    ]);
    const persisted = documentValue as Omit<AssetCanvasDocument, "editorLayout">;
    const editorLayout = layoutValue as AssetCanvasEditorLayout;
    const document: AssetCanvasDocument = {
      ...persisted,
      editorLayout,
      nodes: persisted.nodes.map((node) => ({
        ...node,
        position: editorLayout.nodes[node.id] ?? { x: 0, y: 0 },
      })),
    };
    validate(document);
    await ensureAssetCanvasContract(workspacePath);
    return document;
  });
}

export async function writeAssetCanvasCodebase(workspacePath: string, document: AssetCanvasDocument): Promise<void> {
  await withLock(workspacePath, async () => {
    validate(document);
    const { editorLayout, ...rest } = document;
    const persisted = { ...rest, nodes: rest.nodes.map(({ position: _position, ...node }) => node) };
    await Promise.all([
      writeJsonAtomic(workspacePath, ASSET_CANVAS_FILE, persisted),
      writeJsonAtomic(workspacePath, LAYOUT_FILE, editorLayout),
    ]);
    await ensureAssetCanvasContract(workspacePath);
  });
}

export async function createAssetCanvasCodebase(workspacePath: string): Promise<AssetCanvasDocument> {
  const document = createAssetCanvasDocument();
  await writeAssetCanvasCodebase(workspacePath, document);
  return document;
}

async function ensureAssetCanvasContract(workspacePath: string): Promise<void> {
  await Promise.all([
    ensureFile(path.join(workspacePath, "AGENTS.md"), AGENT_INSTRUCTIONS),
    writeJsonAtomic(workspacePath, CANVAS_SCHEMA_FILE, ASSET_CANVAS_SCHEMA),
    writeJsonAtomic(workspacePath, LAYOUT_SCHEMA_FILE, ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA),
  ]);
}

function validate(document: AssetCanvasDocument): void {
  const { editorLayout, ...rest } = document;
  const persisted = { ...rest, nodes: rest.nodes.map(({ position: _position, ...node }) => node) };
  if (!Check(ASSET_CANVAS_SCHEMA, persisted)) throw new Error("Invalid canvas.json");
  if (!Check(ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA, editorLayout)) throw new Error("Invalid editor/layout.json");
  validateAssetCanvasDocument(document);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function writeJsonAtomic(workspacePath: string, relativePath: string, value: unknown): Promise<void> {
  const destination = path.join(workspacePath, ...relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

async function ensureFile(file: string, contents: string): Promise<void> {
  try {
    await readFile(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
  }
}

function withLock<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(workspacePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  writes.set(workspacePath, settled);
  return result.finally(() => {
    if (writes.get(workspacePath) === settled) writes.delete(workspacePath);
  });
}
