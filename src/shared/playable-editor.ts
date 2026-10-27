import type { NodeGraphValidationIssue } from "./playable-graph-validation.js";
import type {
  NodeGraph,
  PlayableAssetDefinition,
  PlayableAssetType,
  JsonValue,
} from "./playable-nodes.js";
import type { NodePlayerDefinition } from "./playable-player-protocol.js";

export interface PlayableProjectValidationIssue {
  /** `source` is about one Scene's files, which keep that Scene from playing. */
  phase: "graph" | "source";
  code: NodeGraphValidationIssue["code"] | "invalid-json" | "missing-graph" | string;
  path: string;
  message: string;
  /** Node ID, when the issue belongs to one Node. */
  surfaceId?: string;
}

export interface PlayableProjectValidationResult {
  ok: boolean;
  missing?: boolean;
  issues: PlayableProjectValidationIssue[];
  definition?: NodePlayerDefinition;
}

/** A Preset as offered to the editor's add-node menu. */
export interface PlayablePresetSummary {
  id: string;
  label: string;
  /** One line for the author. */
  summary: string;
}

export interface PlayableAddedNode {
  id: string;
  title: string;
  preset: string;
  files: string[];
  signals: string[];
  brief: string;
}

/** A Variable's value in author words: Yes/No, "empty", "3 items". */
export function describePlayableValue(value: JsonValue): string {
  if (value === null) return "nothing";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? "empty" : `"${value}"`;
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.length === 1 ? "1 item" : `${value.length} items`;
  const size = Object.keys(value).length;
  return size === 0 ? "empty" : size === 1 ? "1 field" : `${size} fields`;
}

export function renamePlayableSignal(
  graph: NodeGraph,
  nodeId: string,
  oldId: string,
  newId: string,
): NodeGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !newId || node.signals.some((signal) => signal.id === newId && signal.id !== oldId)) {
    return graph;
  }
  node.signals = node.signals.map((signal) => signal.id === oldId ? { ...signal, id: newId } : signal);
  next.edges = next.edges.map((edge) => edge.source.nodeId === nodeId && edge.source.signal === oldId
    ? { ...edge, source: { ...edge.source, signal: newId } }
    : edge);
  return next;
}

export function deletePlayableSignal(
  graph: NodeGraph,
  nodeId: string,
  signalId: string,
): NodeGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return graph;
  node.signals = node.signals.filter((signal) => signal.id !== signalId);
  next.edges = next.edges.filter((edge) => edge.source.nodeId !== nodeId || edge.source.signal !== signalId);
  return next;
}

export function setPlayableSignalLabel(
  graph: NodeGraph,
  nodeId: string,
  signalId: string,
  label: string,
): NodeGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  const trimmed = label.trim();
  if (!node || !trimmed) return graph;
  node.signals = node.signals.map((signal) => signal.id === signalId ? { ...signal, label: trimmed.slice(0, 120) } : signal);
  return next;
}

/**
 * A new edge's ID: `<source>-<signal>`, which graph.json's ID pattern allows,
 * numbered when another edge already has it.
 */
export function playableEdgeId(edges: readonly { id: string }[], nodeId: string, signalId: string): string {
  const base = `${nodeId}-${signalId}`;
  const taken = new Set(edges.map((edge) => edge.id));
  let id = base;
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`;
  return id;
}

export function playableAssetType(mediaType: string): PlayableAssetType | undefined {
  const kind = mediaType.split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : undefined;
}

/** A readable Asset ID from a file name, unique within `taken`. */
export function playableAssetId(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 100) || "asset";
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Declares an Asset on a Node. A source the graph already declares keeps its
 * Asset ID, so the same Library file is never declared twice.
 */
export function addPlayableNodeAsset(
  graph: NodeGraph,
  nodeId: string,
  asset: { name: string } & PlayableAssetDefinition,
): { graph: NodeGraph; assetId: string } {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  const sameSource = (definition: PlayableAssetDefinition) => JSON.stringify(definition.source) === JSON.stringify(asset.source);
  const existing = Object.entries(next.assets).find(([, definition]) => sameSource(definition))?.[0];
  const assetId = existing ?? playableAssetId(asset.name, new Set(Object.keys(next.assets)));
  if (!node) return { graph, assetId };
  if (!existing) next.assets[assetId] = { type: asset.type, source: asset.source };
  if (!node.assets.includes(assetId)) node.assets.push(assetId);
  return { graph: next, assetId };
}

/** Removes the Asset from the Node, and from the graph once nothing declares it. */
export function removePlayableNodeAsset(graph: NodeGraph, nodeId: string, assetId: string): NodeGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return graph;
  node.assets = node.assets.filter((id) => id !== assetId);
  if (!next.nodes.some((candidate) => candidate.assets.includes(assetId))) delete next.assets[assetId];
  return next;
}

/** Node ID to the thumbnail cached for it in `.ohmygame/thumbnails/`. */
export type PlayableThumbnailManifest = Record<string, { hash: string; capturedAt: string }>;

/**
 * Identifies what a Node thumbnail shows: the Node's files and what they
 * import, the Assets it declares, and the viewport, as checked when the
 * project was built. A cached thumbnail with another hash is stale.
 */
export function playableThumbnailHash(definition: NodePlayerDefinition, nodeId: string): string | undefined {
  return definition.hashes[nodeId];
}
