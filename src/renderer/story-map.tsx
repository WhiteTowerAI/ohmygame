import type { CSSProperties } from "react";
import type { StoryChapter, StoryNode } from "../shared/contracts.js";
import type { StoryProgressFacts } from "../shared/story.js";
import { ChevronLeft } from "./icons.js";
import "./story-map.css";

type StoryMapNode = Extract<StoryNode, { type: "scene" | "interaction" | "choice" | "ending" }>;

export interface StoryMapNodeLayout {
  id: string;
  node: StoryMapNode;
  x: number;
  y: number;
}

export interface StoryMapLayout {
  width: number;
  height: number;
  nodes: StoryMapNodeLayout[];
  edges: { source: string; target: string }[];
}

const NODE_WIDTH = 176;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 84;
const ROW_GAP = 28;
const PADDING = 48;

export function createStoryMapLayout(chapter: StoryChapter, minimum = { width: 0, height: 0 }): StoryMapLayout {
  const mapNodes = chapter.nodes.filter(isStoryMapNode);
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
  const columns = new Map<number, StoryMapNode[]>();
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

export function StoryMap({ chapter, progress, currentNodeId, viewport, onClose }: { chapter: StoryChapter; progress?: StoryProgressFacts; currentNodeId?: string; viewport: { width: number; height: number }; onClose: () => void }) {
  const layout = createStoryMapLayout(chapter, { width: viewport.width, height: Math.max(0, viewport.height - 74) });
  const positions = new Map(layout.nodes.map((item) => [item.id, item]));
  const visited = new Set(progress?.visitedNodeIds ?? []);
  const unlockedEndings = new Set(progress?.unlockedEndingIds ?? []);
  const visitedCount = layout.nodes.filter((item) => visited.has(item.id)).length;
  const endings = layout.nodes.filter((item) => item.node.type === "ending");

  return <section className="story-map" role="dialog" aria-modal="true" aria-label="Story map">
    <header>
      <button type="button" onClick={onClose}><ChevronLeft size={16} />Back</button>
      <div><span>Story map</span><strong>{chapter.title}</strong></div>
      <p><span>{visitedCount}/{layout.nodes.length} discovered</span><span>{unlockedEndings.size}/{endings.length} endings</span></p>
    </header>
    <div className="story-map-scroll">
      <div className="story-map-canvas" style={{ width: layout.width, height: layout.height } as CSSProperties}>
        <svg aria-hidden="true" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          {layout.edges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const x1 = source.x + NODE_WIDTH;
            const y1 = source.y + NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + NODE_HEIGHT / 2;
            const bend = Math.max(28, (x2 - x1) / 2);
            const discovered = visited.has(source.id) && visited.has(target.id);
            return <path key={`${edge.source}:${edge.target}`} className={discovered ? "is-discovered" : undefined} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />;
          })}
        </svg>
        <ol>
          {layout.nodes.map(({ id, node, x, y }) => {
            const discovered = visited.has(id);
            const unlocked = node.type === "ending" && unlockedEndings.has(id);
            const current = id === currentNodeId;
            const state = discovered || unlocked ? "is-discovered" : "is-locked";
            return <li key={id} className={`${state}${current ? " is-current" : ""}`} style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
              <span>{discovered ? storyMapNodeType(node) : node.type === "ending" ? "Locked ending" : "Undiscovered"}</span>
              <strong>{discovered || unlocked ? storyMapNodeTitle(node) : "Unknown"}</strong>
            </li>;
          })}
        </ol>
      </div>
    </div>
  </section>;
}

function isStoryMapNode(node: StoryNode): node is StoryMapNode {
  return node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

function nextMapNodeIds(chapter: StoryChapter, sourceId: string): string[] {
  const pending = chapter.edges.filter((edge) => edge.source === sourceId).map((edge) => edge.target);
  const visited = new Set<string>([sourceId]);
  const result: string[] = [];
  while (pending.length) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = chapter.nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    if (isStoryMapNode(node)) result.push(id);
    else for (const edge of chapter.edges) if (edge.source === id) pending.push(edge.target);
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

function storyMapNodeType(node: StoryMapNode): string {
  if (node.type === "scene") return "Scene";
  if (node.type === "interaction") return "Interaction";
  if (node.type === "choice") return "Choice";
  return "Ending";
}

function storyMapNodeTitle(node: StoryMapNode): string {
  if (node.type === "choice") return node.data.title || "Make a choice";
  return node.data.title || (node.type === "scene" ? "Untitled scene" : node.type === "interaction" ? "Untitled interaction" : "Untitled ending");
}
