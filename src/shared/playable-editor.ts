import type { NodeGraphValidationIssue } from "./playable-graph-validation.js";
import type {
  JsonValue,
  NodeGraph,
  PlayableAssetDefinition,
  PlayableAssetType,
  PlayableNavigationMode,
} from "./playable-nodes.js";
import type { NodePlayerDefinition } from "./playable-player-protocol.js";

export interface PlayableProjectValidationIssue {
  phase: "graph" | "compiler";
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
  brief: string;
  signals: string[];
}

export interface PlayableAddedNode {
  id: string;
  title: string;
  preset: string;
  files: string[];
  signals: string[];
  brief: string;
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

/** Marks an Exit as a way around the game (`navigation`) or part of the story. */
export function setPlayableSignalRole(
  graph: NodeGraph,
  nodeId: string,
  signalId: string,
  navigation: boolean,
): NodeGraph {
  const next = structuredClone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return graph;
  node.signals = node.signals.map((signal) => {
    if (signal.id !== signalId) return signal;
    const { role: _role, ...story } = signal;
    return navigation ? { ...story, role: "navigation" as const } : story;
  });
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

/**
 * One Signal leads to one Node; `undefined` disconnects the Signal. `mode`
 * defaults to the Signal's current mode, else `replace`.
 */
export function setPlayableSignalTarget(
  graph: NodeGraph,
  nodeId: string,
  signalId: string,
  targetNodeId: string | undefined,
  mode?: PlayableNavigationMode,
): NodeGraph {
  const next = structuredClone(graph);
  const current = next.edges.find((edge) => edge.source.nodeId === nodeId && edge.source.signal === signalId);
  next.edges = next.edges.filter((edge) => edge !== current);
  if (targetNodeId && next.nodes.some((node) => node.id === targetNodeId)) {
    next.edges.push({
      id: current?.id ?? playableEdgeId(next.edges, nodeId, signalId),
      source: { nodeId, signal: signalId },
      targetNodeId,
      mode: mode ?? current?.mode ?? "replace",
    });
  }
  return next;
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

export type PlayableStateType = "text" | "number" | "boolean" | "list" | "object" | "null";

/** The type the State panel shows for a key, inferred from its initial value. */
export function playableStateType(value: JsonValue): PlayableStateType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

/**
 * Identifies what a preview session runs. Node titles, Signal labels, and the
 * graph title are editor text the Runtime never reads, so renaming them keeps
 * the running preview.
 */
export function playableRuntimeKey(definition: NodePlayerDefinition): string {
  const { title: _title, nodes, ...graph } = definition.graph;
  return JSON.stringify({
    graph: { ...graph, nodes: nodes.map(({ title: _nodeTitle, signals, ...node }) => ({ ...node, signals: signals.map((signal) => signal.id) })) },
    compiled: definition.compiled,
  });
}

/** Preview State inputs are typed by the key's initial value. */
export function formatPreviewStateInput(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parsePreviewStateInput(
  text: string,
  initial: JsonValue,
): { value: JsonValue } | { error: string } {
  if (typeof initial === "string") return { value: text };
  if (typeof initial === "number") {
    const value = Number(text);
    return text.trim() && Number.isFinite(value) ? { value } : { error: "Enter a number." };
  }
  if (typeof initial === "boolean") return { value: text === "true" };
  try {
    return { value: JSON.parse(text) as JsonValue };
  } catch {
    return { error: "Enter valid JSON." };
  }
}

/** Node ID to the thumbnail cached for it in `.ohmygame/thumbnails/`. */
export type PlayableThumbnailManifest = Record<string, { hash: string; capturedAt: string }>;

/**
 * Identifies what a Node thumbnail shows: the Node's compiled output, the
 * Assets it declares, and the viewport. A cached thumbnail with another hash
 * is stale.
 */
export function playableThumbnailHash(definition: NodePlayerDefinition, nodeId: string): string | undefined {
  const { graph, compiled } = definition;
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  const surface = compiled.nodes[nodeId];
  if (!node || !surface) return undefined;
  const assetIds = [...node.assets].sort();
  return hashText(JSON.stringify({
    node: [surface.html, surface.css, surface.javascript],
    assets: assetIds.map((id) => [id, graph.assets[id] ?? null]),
    viewport: graph.viewport,
  }));
}

/** cyrb53: a fast 53-bit string hash, enough to tell cache entries apart. */
function hashText(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(16).padStart(14, "0");
}
