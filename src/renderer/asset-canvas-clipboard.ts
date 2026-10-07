import type { AssetCanvasEdge, AssetCanvasNode, AssetCanvasReference } from "../shared/contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../shared/asset-canvas.js";
import { snapCanvasPosition } from "./canvas-alignment.js";

export function duplicateAssetCanvasNode(
  node: AssetCanvasNode,
  position: { x: number; y: number },
  id: string = crypto.randomUUID(),
): AssetCanvasNode {
  return duplicateCanvasSelection([node], [], position, () => id).nodes[0]!;
}

export interface CanvasClipboard {
  format: "ohmygame/canvas-nodes";
  version: 1;
  projectId: string;
  nodes: AssetCanvasNode[];
  edges: AssetCanvasEdge[];
}
let copied: CanvasClipboard | undefined;
export const lastCanvasClipboard = () => copied;
export function rememberCanvasClipboard(value: CanvasClipboard) { copied = structuredClone(value); }

function remapReferences(node: AssetCanvasNode, ids: ReadonlyMap<string, string>) {
  const reference = (value: AssetCanvasReference): AssetCanvasReference[] => value.type === "library" ? [value] : ids.has(value.nodeId) ? [{ ...value, nodeId: ids.get(value.nodeId)! }] : [];
  if (node.type === "image" || node.type === "model-3d") node.data.images = node.data.images.flatMap(reference);
  if (node.type === "video") {
    node.data.references = node.data.references.flatMap(reference);
    if (node.data.referenceMentions) node.data.referenceMentions = Object.fromEntries(
      Object.entries(node.data.referenceMentions).map(([alias, value]) => [alias, reference(value)[0] ?? value]),
    );
  }
  if ((node.type === "image" || node.type === "video") && node.data.promptSource) {
    const id = ids.get(node.data.promptSource.nodeId);
    if (id) node.data.promptSource = { type: "node", nodeId: id };
    else delete node.data.promptSource;
  }
  if (node.type === "animate-3d" && node.data.source) {
    const source = reference(node.data.source)[0];
    if (source) node.data.source = source;
    else delete node.data.source;
  }
}

export function createCanvasClipboard(projectId: string, nodes: AssetCanvasNode[], edges: AssetCanvasEdge[]): CanvasClipboard {
  const ids = new Map(nodes.map((node) => [node.id, node.id]));
  const selected = structuredClone(nodes);
  selected.forEach((node) => remapReferences(node, ids));
  return { format: "ohmygame/canvas-nodes", version: 1, projectId, nodes: selected, edges: structuredClone(edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))) };
}

export function parseCanvasClipboard(text: string): CanvasClipboard | undefined {
  if (text.length > 4 * 1024 * 1024) return undefined;
  try {
    const value = JSON.parse(text) as CanvasClipboard;
    if (value?.format !== "ohmygame/canvas-nodes" || value.version !== 1 || typeof value.projectId !== "string" || !Array.isArray(value.nodes) || !value.nodes.length || !Array.isArray(value.edges)) return;
    if (value.nodes.some((node) => !Number.isFinite(node?.position?.x) || !Number.isFinite(node?.position?.y))) return;
    const canvas = createAssetCanvasDocument();
    canvas.nodes = value.nodes; canvas.edges = value.edges;
    canvas.editorLayout.nodes = Object.fromEntries(value.nodes.map((node) => [node.id, node.position]));
    return isAssetCanvasDocument(canvas) ? value : undefined;
  } catch { return undefined; }
}

export function duplicateCanvasSelection(nodes: AssetCanvasNode[], edges: AssetCanvasEdge[], position: { x: number; y: number }, newId: () => string = () => crypto.randomUUID()): { nodes: AssetCanvasNode[]; edges: AssetCanvasEdge[] } {
  const ids = new Map(nodes.map((node) => [node.id, newId()]));
  const left = Math.min(...nodes.map((node) => node.position.x)), top = Math.min(...nodes.map((node) => node.position.y));
  const duplicates = structuredClone(nodes).map((node) => {
    node.id = ids.get(node.id)!;
    node.position = snapCanvasPosition({ x: position.x + node.position.x - left, y: position.y + node.position.y - top });
    remapReferences(node, ids);
    return node;
  });
  return { nodes: duplicates, edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ ...structuredClone(edge), id: newId(), source: ids.get(edge.source)!, target: ids.get(edge.target)! })) };
}
