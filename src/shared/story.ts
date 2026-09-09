import type { StoryChapter, StoryDocument, StoryEdge, StoryNode } from "./contracts.js";

const STORY_NODE_TYPES = new Set(["start", "scene", "choice", "ending"]);

export function createStoryDocument(): StoryDocument {
  return {
    version: 2,
    chapters: [{
      id: crypto.randomUUID(),
      title: "Untitled",
      nodes: [{ id: crypto.randomUUID(), type: "start", position: { x: 80, y: 180 }, data: {} }],
      edges: [],
    }],
  };
}

export function isStoryDocument(value: unknown): value is StoryDocument {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.chapters) || value.chapters.length === 0) return false;
  const chapterIds = new Set<string>();
  return value.chapters.every((chapter) => {
    if (!isRecord(chapter) || !nonEmptyString(chapter.id) || chapterIds.has(chapter.id) || typeof chapter.title !== "string" ||
      !Array.isArray(chapter.nodes) || !Array.isArray(chapter.edges)) return false;
    chapterIds.add(chapter.id);
    const nodes = chapter.nodes as unknown[];
    const nodeIds = new Set<string>();
    const nodeById = new Map<string, StoryNode>();
    for (const node of nodes) {
      if (!isStoryNode(node) || nodeIds.has(node.id)) return false;
      nodeIds.add(node.id);
      nodeById.set(node.id, node);
    }
    if (nodes.filter((node) => isRecord(node) && node.type === "start").length !== 1) return false;
    const edgeIds = new Set<string>();
    const outputs = new Set<string>();
    return (chapter.edges as unknown[]).every((edge) => {
      if (!isRecord(edge) || !nonEmptyString(edge.id) || edgeIds.has(edge.id) ||
        typeof edge.source !== "string" || typeof edge.target !== "string" ||
        !nodeIds.has(edge.source) || !nodeIds.has(edge.target) ||
        (edge.sourceHandle !== undefined && typeof edge.sourceHandle !== "string")) return false;
      const output = `${edge.source}\0${edge.sourceHandle ?? "out"}`;
      if (outputs.has(output)) return false;
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target || source.type === "ending" || target.type === "start") return false;
      const handle = edge.sourceHandle ?? "out";
      if (source.type === "choice" ? !source.data.options.some((option) => option.id === handle) : handle !== "out") return false;
      edgeIds.add(edge.id);
      outputs.add(output);
      return true;
    });
  });
}

export interface StoryPlayIssue {
  nodeId: string;
  message: string;
}

export function getStartNode(chapter: StoryChapter): StoryNode | undefined {
  return chapter.nodes.find((node) => node.type === "start");
}

export function getOutgoingEdge(chapter: StoryChapter, nodeId: string, sourceHandle = "out"): StoryEdge | undefined {
  return chapter.edges.find((edge) => edge.source === nodeId && (edge.sourceHandle ?? "out") === sourceHandle);
}

export function getNextNode(chapter: StoryChapter, nodeId: string, sourceHandle = "out"): StoryNode | undefined {
  const edge = getOutgoingEdge(chapter, nodeId, sourceHandle);
  return edge ? chapter.nodes.find((node) => node.id === edge.target) : undefined;
}

export function replaceOutgoingEdge<T extends { source: string; sourceHandle?: string | null }>(edges: T[], next: T): T[] {
  const nextHandle = next.sourceHandle ?? "out";
  return [
    ...edges.filter((edge) => edge.source !== next.source || (edge.sourceHandle ?? "out") !== nextHandle),
    next,
  ];
}

export function validatePlayableChapter(chapter: StoryChapter, availableAssetIds?: ReadonlySet<string>): StoryPlayIssue | undefined {
  const start = getStartNode(chapter);
  if (!start) return { nodeId: "", message: "This chapter has no Start node." };
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    if (node.type === "ending") continue;
    if (node.type === "scene" && node.data.clips.length === 0) return {
      nodeId: node.id,
      message: `Add at least one video to the scene "${node.data.title || "Untitled scene"}".`,
    };
    if (node.type === "scene" && availableAssetIds) {
      const missing = node.data.clips.find((clip) => !availableAssetIds.has(clip.assetId));
      if (missing) return { nodeId: node.id, message: "A video used by this scene is missing from Library." };
    }
    const handles = node.type === "choice" ? node.data.options.map((option) => option.id) : ["out"];
    for (const handle of handles) {
      const edge = getOutgoingEdge(chapter, node.id, handle);
      if (!edge) return {
        nodeId: node.id,
        message: node.type === "choice"
          ? `Connect the choice "${node.data.options.find((option) => option.id === handle)?.label || "Untitled option"}".`
          : `Connect ${node.type === "start" ? "Start" : `the scene "${node.data.title || "Untitled scene"}"`} to a next node.`,
      };
      const target = chapter.nodes.find((candidate) => candidate.id === edge.target);
      if (!target) return { nodeId: node.id, message: "A connection points to a missing node." };
      pending.push(target);
    }
  }
  return undefined;
}

function isStoryNode(value: unknown): value is StoryNode {
  if (!isRecord(value) || !nonEmptyString(value.id) || typeof value.type !== "string" ||
    !STORY_NODE_TYPES.has(value.type) || !isPosition(value.position) || !isRecord(value.data)) return false;
  if (value.type === "start") return Object.keys(value.data).length === 0;
  if (value.type === "scene") {
    if (typeof value.data.title !== "string") return false;
    if (!Array.isArray(value.data.clips)) return false;
    const clipIds = new Set<string>();
    return value.data.clips.every((clip) => {
      if (!isRecord(clip) || !nonEmptyString(clip.id) || clipIds.has(clip.id) || !nonEmptyString(clip.assetId)) return false;
      clipIds.add(clip.id);
      return true;
    });
  }
  if (value.type === "ending") {
    return typeof value.data.title === "string" && typeof value.data.description === "string";
  }
  if (value.type !== "choice" || typeof value.data.title !== "string" || !Array.isArray(value.data.options) || value.data.options.length < 1) return false;
  const optionIds = new Set<string>();
  return value.data.options.every((option) => {
    if (!isRecord(option) || !nonEmptyString(option.id) || optionIds.has(option.id) || typeof option.label !== "string") return false;
    optionIds.add(option.id);
    return true;
  });
}

function isPosition(value: unknown): boolean {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
