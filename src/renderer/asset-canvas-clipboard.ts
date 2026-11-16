import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { AssetCanvasEdge, AssetCanvasNode, AssetCanvasReference } from "../shared/contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../shared/asset-canvas.js";
import { migrateLegacyAudioNodes } from "../shared/audio-legacy.js";
import { snapCanvasPosition } from "./canvas-alignment.js";
import { canvasNodeLayout, withoutContentNodeSize } from "../shared/canvas-node-layout.js";
import { canvasDownstream } from "../shared/canvas-chains.js";
import { canvasAbsolutePosition, findCanvasFreeArea } from "./canvas-groups.js";

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

/**
 * Copied nodes go in a format only web pages read, so other apps see just
 * what is written beside it: the picture of one image node, or the words of
 * text nodes.
 */
export const CANVAS_CLIPBOARD_TYPE = "web application/x-ohmygame-canvas";

/** What other apps get from copied nodes, if anything. */
export function canvasClipboardOutside(nodes: readonly AssetCanvasNode[]): { imageAssetId?: string; text?: string } {
  const [only] = nodes;
  if (nodes.length === 1 && (only?.type === "image" || (only?.type === "asset" && only.data.mediaType === "image")) && only.data.assetId) return { imageAssetId: only.data.assetId };
  const texts = nodes.flatMap((node) => node.type === "text" && node.data.text?.trim() ? [node.data.text] : []);
  return texts.length === nodes.length && texts.length ? { text: texts.join("\n\n") } : {};
}

let latestWrite = 0;

/**
 * Writes copied nodes, with a PNG of their image when there is one. When the
 * image can't be read, the nodes are still copied, and this resolves false.
 * A later copy wins: an image still loading when it starts is never written.
 */
export async function writeCanvasClipboard(value: CanvasClipboard, outside: { text?: string; png?: Promise<Blob> }): Promise<boolean> {
  const write = ++latestWrite;
  const entries: Record<string, Blob | Promise<Blob>> = { [CANVAS_CLIPBOARD_TYPE]: new Blob([JSON.stringify(value)], { type: CANVAS_CLIPBOARD_TYPE }) };
  if (outside.text) entries["text/plain"] = new Blob([outside.text], { type: "text/plain" });
  if (!outside.png) { await navigator.clipboard.write([new ClipboardItem(entries)]); return true; }
  try {
    await navigator.clipboard.write([new ClipboardItem({ ...entries, "image/png": unlessSuperseded(outside.png, write) })]);
    return true;
  } catch {
    if (write !== latestWrite) return true;
    await navigator.clipboard.write([new ClipboardItem(entries)]);
    return false;
  }
}

/** Writes just a picture. A later copy wins here too. */
export async function writeImageClipboard(png: Promise<Blob>): Promise<void> {
  const write = ++latestWrite;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": unlessSuperseded(png, write) })]);
  } catch (cause) {
    if (write === latestWrite) throw cause;
  }
}

/** The clipboard waits for an image before writing anything, so a superseded copy fails instead. */
function unlessSuperseded(png: Promise<Blob>, write: number): Promise<Blob> {
  return png.then((blob) => { if (write !== latestWrite) throw new Error("A later copy replaced this one."); return blob; });
}

/** Nodes copied from a canvas, read from the clipboard a paste came from. */
export async function readCanvasClipboard(): Promise<CanvasClipboard | undefined> {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes(CANVAS_CLIPBOARD_TYPE)) return parseCanvasClipboard(await (await item.getType(CANVAS_CLIPBOARD_TYPE)).text());
    }
  } catch { /* Nothing readable is nothing to paste. */ }
  return undefined;
}

function remapReferences(node: AssetCanvasNode, ids: ReadonlyMap<string, string>) {
  const reference = (value: AssetCanvasReference): AssetCanvasReference[] => value.type === "library" ? [value] : ids.has(value.nodeId) ? [{ ...value, nodeId: ids.get(value.nodeId)! }] : [];
  if (node.type === "image" || node.type === "model-3d") node.data.images = node.data.images.flatMap(reference);
  if (node.type === "plugin") node.data.inputs = Object.fromEntries(Object.entries(node.data.inputs).map(([key, references]) => [key, references.flatMap(reference)]));
  if ((node.type === "text" || node.type === "document") && node.data.references) {
    node.data.references = node.data.references.flatMap((value) => ids.has(value.nodeId) ? [{ type: "node" as const, nodeId: ids.get(value.nodeId)! }] : []);
  }
  if (node.type === "video") {
    node.data.references = node.data.references.flatMap(reference);
    if (node.data.referenceMentions) node.data.referenceMentions = Object.fromEntries(
      Object.entries(node.data.referenceMentions).map(([alias, value]) => [alias, reference(value)[0] ?? value]),
    );
  }
  if ((node.type === "image" || node.type === "video" || node.type === "model-3d" || node.type === "audio") && node.data.promptSource) {
    const id = ids.get(node.data.promptSource.nodeId);
    if (id) node.data.promptSource = { type: "node", nodeId: id };
    else delete node.data.promptSource;
  }
  if ((node.type === "animate-3d" || node.type === "model-3d") && node.data.source) {
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
    const parsed = JSON.parse(text) as CanvasClipboard;
    if (parsed?.format !== "ohmygame/canvas-nodes" || parsed.version !== 1 || typeof parsed.projectId !== "string" || !Array.isArray(parsed.nodes) || !parsed.nodes.length || !Array.isArray(parsed.edges)) return;
    // Nodes copied from a board saved before sizes were validated may still carry them.
    const current = migrateLegacyAudioNodes(parsed).value;
    const value = { ...current, nodes: current.nodes.map(withoutContentNodeSize) };
    if (value.nodes.some((node) => !Number.isFinite(node?.position?.x) || !Number.isFinite(node?.position?.y))) return;
    const canvas = createAssetCanvasDocument();
    canvas.nodes = value.nodes; canvas.edges = value.edges;
    canvas.editorLayout.nodes = Object.fromEntries(value.nodes.map((node) => [node.id, canvasNodeLayout(node)]));
    return isAssetCanvasDocument(canvas) ? value : undefined;
  } catch { return undefined; }
}

export function duplicateCanvasSelection(nodes: AssetCanvasNode[], edges: AssetCanvasEdge[], position: { x: number; y: number }, newId: () => string = () => crypto.randomUUID()): { nodes: AssetCanvasNode[]; edges: AssetCanvasEdge[] } {
  const ids = new Map(nodes.map((node) => [node.id, newId()]));
  const idsInSelection = new Set(nodes.map((node) => node.id));
  const roots = nodes.filter((node) => !node.parentId || !idsInSelection.has(node.parentId));
  const left = Math.min(...roots.map((node) => node.position.x)), top = Math.min(...roots.map((node) => node.position.y));
  const duplicates = structuredClone(nodes).map((node) => {
    const parentId = node.parentId;
    node.id = ids.get(node.id)!;
    if (parentId && ids.has(parentId)) node.parentId = ids.get(parentId)!;
    else delete node.parentId;
    node.position = node.parentId ? node.position : snapCanvasPosition({ x: position.x + node.position.x - left, y: position.y + node.position.y - top });
    remapReferences(node, ids);
    return node;
  });
  return { nodes: duplicates, edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ ...structuredClone(edge), id: newId(), source: ids.get(edge.source)!, target: ids.get(edge.target)! })) };
}

/**
 * For each image, a copy of what comes after `sourceId`, reading that
 * Library image in its place, in a group of its own placed clear of the
 * board. Copies start without outputs; links to nodes outside the chain,
 * such as a shared prompt, stay. `starts` are the new image nodes, one per
 * group, to run each copy from.
 */
/** The pixel density a node gets from the nearest group that sets one. */
function inheritedPixelStyle(nodes: readonly AssetCanvasNode[], node: AssetCanvasNode): PixelArtLevel | undefined {
  const seen = new Set<string>();
  for (let parentId = node.parentId; parentId && !seen.has(parentId);) {
    seen.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (parent?.type !== "group") return undefined;
    if (parent.data.pixelStyle) return parent.data.pixelStyle;
    parentId = parent.parentId;
  }
  return undefined;
}

export function canvasBatchCopies(
  nodes: readonly AssetCanvasNode[],
  sourceId: string,
  images: ReadonlyArray<{ assetId: string; name: string }>,
  groupName: (name: string) => string,
  newId: () => string = () => crypto.randomUUID(),
): { nodes: AssetCanvasNode[]; starts: string[] } {
  const source = nodes.find((node) => node.id === sourceId);
  if (!source) return { nodes: [], starts: [] };
  const chain = [source, ...canvasDownstream(nodes, sourceId)];
  const at = new Map(chain.map((node) => [node.id, canvasAbsolutePosition(node, nodes)]));
  const left = Math.min(...[...at.values()].map((point) => point.x)), top = Math.min(...[...at.values()].map((point) => point.y));
  const width = Math.min(4096, Math.max(...chain.map((node) => at.get(node.id)!.x + (node.width ?? 440))) - left + 56);
  const height = Math.min(4096, Math.max(...chain.map((node) => at.get(node.id)!.y + (node.height ?? 400))) - top + 82);
  const placed: AssetCanvasNode[] = [...nodes];
  const copies: AssetCanvasNode[] = [], starts: string[] = [];
  for (const image of images) {
    const ids = new Map(nodes.map((node) => [node.id, node.id]));
    for (const node of chain) ids.set(node.id, newId());
    const groupId = newId();
    const position = findCanvasFreeArea(placed, { width, height }, { x: left - 28, y: top + height + 80 });
    const group: AssetCanvasNode = { id: groupId, type: "group", position, width, height, data: { name: groupName(image.name).slice(0, 120) || "Batch" } };
    const inside = (node: AssetCanvasNode) => ({ x: at.get(node.id)!.x - left + 28, y: at.get(node.id)!.y - top + 54 });
    const start: AssetCanvasNode = { id: ids.get(sourceId)!, type: "asset", parentId: groupId, position: inside(source), data: { assetId: image.assetId, mediaType: "image" } };
    const rest = chain.slice(1).map((node) => {
      const copy = structuredClone(node) as AssetCanvasNode;
      copy.id = ids.get(node.id)!;
      copy.parentId = groupId;
      copy.position = inside(node);
      // The new group has no pixel density, so an image keeps the one it got from its groups.
      if (copy.type === "image" && !copy.data.pixelStyle) {
        const inherited = inheritedPixelStyle(nodes, node);
        if (inherited) copy.data.pixelStyle = inherited;
      }
      // Each copy makes its own output.
      const data = copy.data as { assetId?: string; text?: string };
      delete data.assetId;
      if (copy.type === "plugin") delete data.text;
      remapReferences(copy, ids);
      return copy;
    });
    copies.push(group, start, ...rest);
    placed.push(group);
    starts.push(start.id);
  }
  return { nodes: copies, starts };
}
