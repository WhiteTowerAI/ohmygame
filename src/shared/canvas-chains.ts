import type { AssetCanvasNode } from "./contracts.js";

// How canvas nodes feed one another: which nodes a node reads, what each
// gives, and which outputs no longer match what a run read.

/** The nodes a node reads, in the order its references name them, each once. */
export function canvasNodeSourceIds(node: Pick<AssetCanvasNode, "type" | "data">): string[] {
  const data = node.data as Record<string, unknown>;
  const references = [
    ...(Array.isArray(data.images) ? data.images : []),
    ...(Array.isArray(data.references) ? data.references : []),
    data.promptSource,
    data.source,
    ...(node.type === "plugin" && data.inputs && typeof data.inputs === "object" ? Object.values(data.inputs).flat() : []),
  ] as Array<{ type?: string; nodeId?: string } | undefined>;
  return [...new Set(references.flatMap((reference) => reference?.type === "node" && typeof reference.nodeId === "string" ? [reference.nodeId] : []))];
}

/** A short, stable name for text, the same in the app and the daemon. */
export function canvasTextKey(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `text:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * What a node gives the nodes that read it: its file, or its text. A
 * Document node's text is its Markdown, which the caller looks up.
 */
export function canvasOutputKey(node: Pick<AssetCanvasNode, "type" | "data">, markdown?: (documentId: string) => string | undefined): string | undefined {
  const data = node.data as { assetId?: string; text?: string; documentId?: string };
  if (data.assetId) return `asset:${data.assetId}`;
  if (node.type === "document" && data.documentId) {
    const text = markdown?.(data.documentId);
    return text === undefined ? undefined : canvasTextKey(text);
  }
  return (node.type === "text" || node.type === "plugin") && typeof data.text === "string" ? canvasTextKey(data.text) : undefined;
}

/** What each source gave when a run started, by source node id. */
export function canvasUpstreamKeys(nodes: readonly AssetCanvasNode[], node: AssetCanvasNode, markdown?: (documentId: string) => string | undefined): Record<string, string> {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  return Object.fromEntries(canvasNodeSourceIds(node).flatMap((id) => {
    const source = byId.get(id), key = source ? canvasOutputKey(source, markdown) : undefined;
    return key ? [[id, key]] : [];
  }));
}

/** The nodes that read `id`, directly or through others, in an order where each comes after what it reads. */
export function canvasDownstream(nodes: readonly AssetCanvasNode[], id: string): AssetCanvasNode[] {
  const readers = new Map<string, AssetCanvasNode[]>();
  for (const node of nodes) for (const source of canvasNodeSourceIds(node)) readers.set(source, [...readers.get(source) ?? [], node]);
  const reached = new Set<string>(), stack = [id];
  while (stack.length) for (const reader of readers.get(stack.pop()!) ?? []) if (!reached.has(reader.id) && reader.id !== id) { reached.add(reader.id); stack.push(reader.id); }
  // Depth-first by sources keeps each node after everything it reads.
  const ordered: AssetCanvasNode[] = [], done = new Set<string>([id]), byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (node: AssetCanvasNode, path: Set<string>) => {
    if (done.has(node.id) || path.has(node.id)) return;
    path.add(node.id);
    for (const source of canvasNodeSourceIds(node)) if (reached.has(source)) visit(byId.get(source)!, path);
    path.delete(node.id); done.add(node.id); ordered.push(node);
  };
  for (const node of nodes) if (reached.has(node.id)) visit(node, new Set());
  return ordered;
}

/** Nodes the daemon runs in a chain. */
export function canvasNodeRuns(node: Pick<AssetCanvasNode, "type" | "data">): boolean {
  return ["video", "model-3d", "animate-3d", "speech", "sound-effect", "music", "audio-scene", "plugin"].includes(node.type) || (node.type === "image" && !(node.data as { sourceInput?: boolean }).sourceInput);
}

/** How many generations regenerating from `id` can run: the node, if it makes something, and what runs after it. */
export function canvasChainRuns(nodes: readonly AssetCanvasNode[], id: string): number {
  const start = nodes.find((node) => node.id === id);
  return start ? [start, ...canvasDownstream(nodes, id)].filter(canvasNodeRuns).length : 0;
}

/**
 * A Text or Document node after `id` that something run after it reads. A
 * chain doesn't write text, so the nodes after it would run on its old words.
 */
export function canvasChainTextStep(nodes: readonly AssetCanvasNode[], id: string): AssetCanvasNode | undefined {
  return canvasDownstream(nodes, id).find((node) => (node.type === "text" || node.type === "document") && canvasDownstream(nodes, node.id).some(canvasNodeRuns));
}

/** Whether `id` and the nodes after it read one another in a loop, which no order can run. */
export function canvasChainHasCycle(nodes: readonly AssetCanvasNode[], id: string): boolean {
  const members = new Set([id, ...canvasDownstream(nodes, id).map((node) => node.id)]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "open" | "done">();
  const loops = (nodeId: string): boolean => {
    if (state.get(nodeId) === "done") return false;
    if (state.get(nodeId) === "open") return true;
    state.set(nodeId, "open");
    if (canvasNodeSourceIds(byId.get(nodeId)!).some((source) => members.has(source) && loops(source))) return true;
    state.set(nodeId, "done");
    return false;
  };
  return [...members].some(loops);
}

/**
 * Nodes whose output came from inputs that have since changed, and every
 * node after them that made something. `upstream` is what each node's last
 * finished run read.
 */
export function staleCanvasNodes(nodes: readonly AssetCanvasNode[], upstream: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>, markdown?: (documentId: string) => string | undefined): Set<string> {
  const stale = new Set<string>();
  for (const node of nodes) {
    const read = upstream[node.id];
    if (!read || !canvasOutputKey(node)) continue;
    // A source that changed, went away, or was added or swapped since the run.
    const now = canvasUpstreamKeys(nodes, node, markdown);
    if (Object.keys(now).length !== Object.keys(read).length || Object.entries(read).some(([id, key]) => now[id] !== key)) stale.add(node.id);
  }
  for (const id of [...stale]) for (const node of canvasDownstream(nodes, id)) if (upstream[node.id] && canvasOutputKey(node)) stale.add(node.id);
  return stale;
}
