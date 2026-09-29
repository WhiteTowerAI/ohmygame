import type { StoryDocument, StoryNode, StorySceneMedia } from "./contracts.js";

export interface StoryCoverSource {
  assetId: string;
  mediaType: "image" | "video";
}

/** Finds the first authored image/video reachable from the story entry point. */
export function findStoryCoverSource(story: StoryDocument): StoryCoverSource | undefined {
  const nodes = new Map(story.chapter.nodes.map((node) => [node.id, node] as const));
  const edges = new Map<string, StoryNode[]>();
  for (const edge of story.chapter.edges) {
    const target = nodes.get(edge.target);
    if (target) edges.set(edge.source, [...(edges.get(edge.source) ?? []), target]);
  }
  const start = nodes.get(story.chapter.nodes.find((node) => node.type === "start")?.id ?? "");
  if (!start) return undefined;

  const queue = [start];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    const source = nodeCoverSource(node, nodes, new Set());
    if (source) return source;
    queue.push(...(edges.get(node.id) ?? []));
  }
  return undefined;
}

function nodeCoverSource(node: StoryNode, nodes: Map<string, StoryNode>, resolving: Set<string>): StoryCoverSource | undefined {
  if (resolving.has(node.id)) return undefined;
  resolving.add(node.id);
  if (node.type === "asset" && (node.data.mediaType === "image" || node.data.mediaType === "video")) {
    return { assetId: node.data.assetId, mediaType: node.data.mediaType };
  }
  if (node.type === "image" && node.data.assetId) return { assetId: node.data.assetId, mediaType: "image" };
  if (node.type === "video" && node.data.assetId) return { assetId: node.data.assetId, mediaType: "video" };
  if ("presentation" in node.data) {
    for (const item of node.data.presentation.media.items) {
      const source = mediaSource(item, nodes, resolving);
      if (source) return source;
    }
  }
  return undefined;
}

function mediaSource(item: StorySceneMedia, nodes: Map<string, StoryNode>, resolving: Set<string>): StoryCoverSource | undefined {
  if (item.source.type === "library") return { assetId: item.source.assetId, mediaType: item.type };
  const node = nodes.get(item.source.nodeId);
  return node ? nodeCoverSource(node, nodes, resolving) : undefined;
}
