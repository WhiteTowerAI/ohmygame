import { useMemo } from "react";
import type { StoryChapter, StoryNode } from "../shared/contracts.js";
import type { StoryProgressFacts } from "../shared/story.js";
import { StoryScreenSurface } from "./story-screen-surface.js";
import "./story-map.css";

type StoryMapFlowNode = Extract<StoryNode, { type: "scene" | "interaction" | "choice" | "ending" }>;
type StoryMapSystemNode = Extract<StoryNode, { type: "story-map" }>;

export interface StoryMapNodeLayout {
  id: string;
  node: StoryMapFlowNode;
  x: number;
  y: number;
}

export interface StoryMapLayout {
  width: number;
  height: number;
  nodes: StoryMapNodeLayout[];
  edges: { source: string; target: string }[];
}

export interface StoryMapContent {
  screenTitle: string;
  title: string;
  accentColor: string;
  width: number;
  height: number;
  discoveredCount: number;
  endingCount: number;
  unlockedEndingCount: number;
  nodes: Array<{
    id: string;
    type: StoryMapFlowNode["type"];
    label: string;
    title: string;
    state: "discovered" | "locked";
    current: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  edges: Array<{ source: string; target: string; discovered: boolean }>;
}

const NODE_WIDTH = 176;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 84;
const ROW_GAP = 28;
const PADDING = 48;
const HEADER_HEIGHT = 74;

export function createStoryMapLayout(chapter: StoryChapter, minimum = { width: 0, height: 0 }): StoryMapLayout {
  const mapNodes = chapter.nodes.filter(isStoryMapFlowNode);
  const mapNodeIds = new Set(mapNodes.map((node) => node.id));
  const edges = uniqueMapEdges(mapNodes.flatMap((node) => nextMapNodeIds(chapter, node.id).map((target) => ({ source: node.id, target }))));
  const start = chapter.nodes.find((node) => node.type === "start");
  const roots = start ? nextMapNodeIds(chapter, start.id) : [];
  const incoming = new Set(edges.map((edge) => edge.target));
  const fallbackRoots = mapNodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  const pending = [...new Set([...roots, ...fallbackRoots])].filter((id) => mapNodeIds.has(id)).map((id) => ({ id, depth: 0 }));
  const depths = new Map<string, number>();
  while (pending.length) {
    const current = pending.shift()!;
    if (depths.has(current.id)) continue;
    depths.set(current.id, current.depth);
    for (const edge of edges) if (edge.source === current.id) pending.push({ id: edge.target, depth: current.depth + 1 });
  }
  const lastDepth = Math.max(0, ...depths.values());
  for (const node of mapNodes) if (!depths.has(node.id)) depths.set(node.id, lastDepth + 1);
  const columns = new Map<number, StoryMapFlowNode[]>();
  for (const node of mapNodes) {
    const depth = depths.get(node.id) ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }
  const columnCount = Math.max(0, ...columns.keys()) + 1;
  const rowCount = Math.max(1, ...[...columns.values()].map((nodes) => nodes.length));
  const width = Math.max(minimum.width, PADDING * 2 + columnCount * NODE_WIDTH + Math.max(0, columnCount - 1) * COLUMN_GAP);
  const height = Math.max(minimum.height, PADDING * 2 + rowCount * NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP);
  const nodes = [...columns.entries()].flatMap(([depth, column]) => {
    const columnHeight = column.length * NODE_HEIGHT + Math.max(0, column.length - 1) * ROW_GAP;
    const top = (height - columnHeight) / 2;
    return column.map((node, index) => ({ id: node.id, node, x: PADDING + depth * (NODE_WIDTH + COLUMN_GAP), y: top + index * (NODE_HEIGHT + ROW_GAP) }));
  });
  return { width, height, nodes, edges };
}

export function createStoryMapContent(chapter: StoryChapter, progress: StoryProgressFacts | undefined, currentNodeId: string | undefined, viewport: { width: number; height: number }, accentColor: string, screenTitle = "Story Map"): StoryMapContent {
  const layout = createStoryMapLayout(chapter, { width: viewport.width, height: Math.max(0, viewport.height - HEADER_HEIGHT) });
  const visited = new Set(progress?.visitedNodeIds ?? []);
  const unlockedEndings = new Set(progress?.unlockedEndingIds ?? []);
  const endings = layout.nodes.filter((item) => item.node.type === "ending");
  return {
    screenTitle,
    title: chapter.title,
    accentColor,
    width: layout.width,
    height: layout.height,
    discoveredCount: layout.nodes.filter((item) => visited.has(item.id)).length,
    endingCount: endings.length,
    unlockedEndingCount: endings.filter((item) => unlockedEndings.has(item.id)).length,
    nodes: layout.nodes.map(({ id, node, x, y }) => {
      const discovered = visited.has(id);
      const unlocked = node.type === "ending" && unlockedEndings.has(id);
      return {
        id,
        type: node.type,
        label: discovered ? storyMapNodeType(node) : node.type === "ending" ? "Locked ending" : "Undiscovered",
        title: discovered || unlocked ? storyMapNodeTitle(node) : "Unknown",
        state: discovered || unlocked ? "discovered" : "locked",
        current: id === currentNodeId,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
    }),
    edges: layout.edges.map((edge) => ({ ...edge, discovered: visited.has(edge.source) && visited.has(edge.target) })),
  };
}

export function StoryMapSurface({ chapter, node, progress, currentNodeId, viewport, accentColor, mode, onClose, onReady }: {
  chapter: StoryChapter;
  node: StoryMapSystemNode;
  progress?: StoryProgressFacts;
  currentNodeId?: string;
  viewport: { width: number; height: number };
  accentColor: string;
  mode: "preview" | "runtime";
  onClose: () => void;
  onReady?: () => void;
}) {
  const screenTitle = node.data.title || "Story Map";
  const content = useMemo(
    () => createStoryMapContent(chapter, progress, currentNodeId, viewport, accentColor, screenTitle),
    [accentColor, chapter, currentNodeId, progress, screenTitle, viewport.height, viewport.width],
  );
  return <StoryScreenSurface
    files={node.data.presentation.surface.files}
    content={content}
    mode={mode}
    title={screenTitle}
    className="story-map-surface"
    onReady={onReady}
    onAction={(action) => { if (action === "close") onClose(); }}
  />;
}

export function StoryMap({ chapter, node, progress, currentNodeId, viewport, accentColor, onClose }: {
  chapter: StoryChapter;
  node: StoryMapSystemNode;
  progress?: StoryProgressFacts;
  currentNodeId?: string;
  viewport: { width: number; height: number };
  accentColor: string;
  onClose: () => void;
}) {
  return <section className="story-map" role="dialog" aria-modal="true" aria-label="Story map">
    <StoryMapSurface chapter={chapter} node={node} progress={progress} currentNodeId={currentNodeId} viewport={viewport} accentColor={accentColor} mode="runtime" onClose={onClose} />
  </section>;
}

function isStoryMapFlowNode(node: StoryNode): node is StoryMapFlowNode {
  return node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

function nextMapNodeIds(chapter: StoryChapter, sourceId: string): string[] {
  const pending = chapter.edges.filter((edge) => edge.source === sourceId && edge.sourceHandle !== "story-map").map((edge) => edge.target);
  const visited = new Set<string>([sourceId]);
  const result: string[] = [];
  while (pending.length) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = chapter.nodes.find((candidate) => candidate.id === id);
    if (!node || node.type === "story-map") continue;
    if (isStoryMapFlowNode(node)) result.push(id);
    else for (const edge of chapter.edges) if (edge.source === id && edge.sourceHandle !== "story-map") pending.push(edge.target);
  }
  return [...new Set(result)];
}

function uniqueMapEdges(edges: { source: string; target: string }[]): { source: string; target: string }[] {
  const seen = new Set<string>();
  const unique: { source: string; target: string }[] = [];
  for (const edge of edges) {
    const id = `${edge.source}:${edge.target}`;
    if (edge.source === edge.target || seen.has(id)) continue;
    seen.add(id);
    unique.push(edge);
  }
  return unique;
}

function storyMapNodeType(node: StoryMapFlowNode): string {
  if (node.type === "scene") return "Scene";
  if (node.type === "interaction") return "Interaction";
  if (node.type === "choice") return "Choice";
  return "Ending";
}

function storyMapNodeTitle(node: StoryMapFlowNode): string {
  if (node.type === "choice") return node.data.title || "Make a choice";
  return node.data.title || (node.type === "scene" ? "Untitled scene" : node.type === "interaction" ? "Untitled interaction" : "Untitled ending");
}
