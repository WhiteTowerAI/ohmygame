import { Type } from "typebox";
import { Check } from "typebox/value";
import type { AssetCanvasDocument, AssetCanvasNode } from "./contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "./asset-canvas.js";
import type { GameDesignDocument } from "./game-design.js";
import { ASSET_CANVAS_SCHEMA, ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA } from "./asset-canvas-schema.js";

export type DesignBoard = AssetCanvasDocument & { id: string };
export interface DesignBoardDetail { board: DesignBoard; revision: string }
export interface DesignWorkspaceIndex {
  version: 1;
  mainDocumentId?: string;
  boards: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; title: string }>;
}
export interface DesignWorkspaceDetail extends Omit<DesignWorkspaceIndex, "documents"> {
  documents: Array<GameDesignDocument & { revision: string; source: string; main: boolean }>;
}
const id = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,100}$" });
export const DESIGN_INDEX_SCHEMA = Type.Object({
  version: Type.Literal(1), mainDocumentId: Type.Optional(id),
  boards: Type.Array(Type.Object({ id, name: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
  documents: Type.Array(Type.Object({ id, title: Type.String({ maxLength: 200 }) }, { additionalProperties: false }), { maxItems: 200 }),
}, { additionalProperties: false });
export const DESIGN_BOARD_SCHEMA = { ...ASSET_CANVAS_SCHEMA, required: [...ASSET_CANVAS_SCHEMA.required, "id", "editorLayout"], properties: { ...ASSET_CANVAS_SCHEMA.properties, id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" }, editorLayout: ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA } };
export function isDesignIndex(value: unknown): value is DesignWorkspaceIndex {
  if (!Check(DESIGN_INDEX_SCHEMA, value)) return false;
  const index = value as DesignWorkspaceIndex;
  return new Set(index.boards.map((board) => board.id)).size === index.boards.length && new Set(index.documents.map((document) => document.id)).size === index.documents.length && (!index.mainDocumentId || index.documents.some((document) => document.id === index.mainDocumentId));
}
export function isDesignBoard(value: unknown): value is DesignBoard {
  if (!value || typeof value !== "object") return false;
  const { id: boardId, ...canvas } = value as DesignBoard;
  return typeof boardId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(boardId) && isAssetCanvasDocument(canvas);
}
export function createDesignBoard(id = crypto.randomUUID()): DesignBoard { return { ...createAssetCanvasDocument(), id }; }
export function mergeCanvasDocument(base: AssetCanvasDocument, local: AssetCanvasDocument, remote: AssetCanvasDocument): AssetCanvasDocument | undefined {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const merge = <T>(a: T, b: T, c: T): T | undefined => equal(b, c) || equal(a, c) ? b : equal(a, b) ? c : undefined;
  const nodes: AssetCanvasNode[] = [];
  for (const id of new Set([...local.nodes, ...remote.nodes].map((node) => node.id))) {
    const before = base.nodes.find((node) => node.id === id), ours = local.nodes.find((node) => node.id === id), theirs = remote.nodes.find((node) => node.id === id);
    if (!ours && before) continue;
    if (!theirs && before) { if (!equal(before, ours)) return undefined; continue; }
    if (!ours || !theirs || !before) { if (ours && theirs && !equal(ours, theirs)) return undefined; nodes.push((ours ?? theirs)!); continue; }
    if (before.type !== ours.type || ours.type !== theirs.type) return undefined;
    const position = merge(before.position, ours.position, theirs.position);
    if (!position) return undefined;
    const data: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before.data), ...Object.keys(ours.data), ...Object.keys(theirs.data)])) {
      const a = (before.data as Record<string, unknown>)[key], b = (ours.data as Record<string, unknown>)[key], c = (theirs.data as Record<string, unknown>)[key];
      if (!equal(a, b) && !equal(a, c) && !equal(b, c)) return undefined;
      const value = merge(a, b, c);
      if (value !== undefined) data[key] = value;
    }
    nodes.push({ ...ours, position, data } as AssetCanvasNode);
  }
  const edges = [];
  for (const id of new Set([...local.edges, ...remote.edges].map((edge) => edge.id))) {
    const before = base.edges.find((edge) => edge.id === id), ours = local.edges.find((edge) => edge.id === id), theirs = remote.edges.find((edge) => edge.id === id);
    if (before && !ours) continue;
    if (before && !theirs) { if (!equal(before, ours)) return undefined; continue; }
    const edge = merge(before, ours, theirs);
    if (!edge) return undefined;
    edges.push(edge);
  }
  const viewport = merge(base.viewport, local.viewport, remote.viewport);
  if (!viewport) return undefined;
  const ids = new Set(nodes.map((node) => node.id));
  const cleaned = nodes.map((node) => {
    const data = { ...node.data };
    if ("images" in data) data.images = data.images.filter((ref) => ref.type === "library" || ids.has(ref.nodeId));
    if ("references" in data) data.references = data.references.filter((ref) => ref.type === "library" || ids.has(ref.nodeId));
    if ("source" in data && data.source?.type === "node" && !ids.has(data.source.nodeId)) delete data.source;
    if ("promptSource" in data && data.promptSource && !ids.has(data.promptSource.nodeId)) delete data.promptSource;
    return { ...node, data } as AssetCanvasNode;
  });
  return { ...local, nodes: cleaned, edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), viewport, editorLayout: { ...local.editorLayout, viewport: merge(base.editorLayout.viewport, local.editorLayout.viewport, remote.editorLayout.viewport) ?? local.editorLayout.viewport, nodes: Object.fromEntries(nodes.map((node) => [node.id, node.position])) } };
}
