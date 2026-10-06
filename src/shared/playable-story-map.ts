import type { NodeGraph, PlayableEdge, PlayableNode, PlayableStoryOptions } from "./playable-nodes.js";

/**
 * What the player has seen, across every game they start: when each Node was
 * first entered and each edge first taken. The Runtime keeps it apart from
 * the save, so starting a new game or editing the graph keeps it. IDs that
 * are no longer in the graph are ignored.
 */
export interface PlayableSeen {
  version: 1;
  nodes: Record<string, string>;
  edges: Record<string, string>;
}

/**
 * The story as a map the player can be shown, laid out in rows from the start
 * down. `row` and `column` place a Node, not pixels: `column` counts from the
 * left within its row, so a Node can center each row in any width.
 */
export interface PlayableStoryMap {
  nodes: PlayableStoryMapNode[];
  edges: PlayableStoryMapEdge[];
}

export interface PlayableStoryMapNode {
  id: string;
  /** The Node's `story.label`, else its title. */
  label: string;
  row: number;
  column: number;
  /** How many Nodes share the row. */
  rowSize: number;
  ending: boolean;
  seen: boolean;
}

export interface PlayableStoryMapEdge {
  from: string;
  to: string;
  /** The player went this way: the edge it starts with was taken, and its target seen. */
  seen: boolean;
}

/** A Map edge before the player's progress is applied: `via` is the graph edge it starts with. */
interface StoryLink {
  from: string;
  to: string;
  via: string;
}

/** The map's shape, which depends only on the graph. */
export interface PlayableStoryLayout {
  nodes: Omit<PlayableStoryMapNode, "seen">[];
  links: StoryLink[];
}

export function emptyPlayableSeen(): PlayableSeen {
  return { version: 1, nodes: {}, edges: {} };
}

/** Reads a stored record; anything unreadable starts over. */
export function parsePlayableSeen(value: unknown): PlayableSeen {
  if (!isRecord(value) || value.version !== 1 || !isTimes(value.nodes) || !isTimes(value.edges)) return emptyPlayableSeen();
  return { version: 1, nodes: { ...value.nodes }, edges: { ...value.edges } };
}

/** A Node is an ending when it says so, or else when every Signal it has is navigation. */
export function isPlayableStoryEnding(node: PlayableNode): boolean {
  return node.story?.ending ?? !node.signals.some((signal) => signal.role !== "navigation");
}

/**
 * Sets one story option, leaving it out when it matches what the map assumes
 * without it, and leaving `story` out when nothing is left.
 */
export function withPlayableStoryOption(node: PlayableNode, option: "hidden" | "ending", value: boolean): PlayableNode {
  const { story, ...rest } = node;
  const next: PlayableStoryOptions = { ...story };
  delete next[option];
  const assumed = option === "hidden" ? false : isPlayableStoryEnding({ ...rest, story: next });
  if (value !== assumed) next[option] = value;
  return Object.keys(next).length ? { ...rest, story: next } : rest;
}

/**
 * Lays out the story. A step in the story is a `replace` edge from a Signal
 * that is not navigation; `push` edges lead to side screens the player comes
 * back from, so their targets are only on the map when the story reaches them
 * another way. Hidden Nodes are left out and the steps through them joined,
 * so a menu between two Scenes links them directly. Steps back to a Node
 * already above, such as retrying a failed QTE, are left out too, so the map
 * always reads downwards.
 */
export function layoutPlayableStory(graph: NodeGraph): PlayableStoryLayout {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const shown = (id: string) => !byId.get(id)?.story?.hidden;

  /** The story steps out of a Node, in the order of its Signals. */
  const steps = (node: PlayableNode): PlayableEdge[] => node.signals
    .filter((signal) => signal.role !== "navigation")
    .flatMap((signal) => graph.edges.filter((edge) => edge.source.nodeId === node.id
      && edge.source.signal === signal.id
      && edge.mode === "replace"
      && byId.has(edge.targetNodeId)));

  /** The shown Nodes a Node's steps reach, walking through hidden ones. */
  const reach = (id: string): StoryLink[] => {
    const links: StoryLink[] = [];
    const visited = new Set([id]);
    const walk = (nodeId: string, via: string | undefined) => {
      for (const edge of steps(byId.get(nodeId)!)) {
        const first = via ?? edge.id;
        if (shown(edge.targetNodeId)) {
          if (!links.some((link) => link.to === edge.targetNodeId)) links.push({ from: id, to: edge.targetNodeId, via: first });
        } else if (!visited.has(edge.targetNodeId)) {
          visited.add(edge.targetNodeId);
          walk(edge.targetNodeId, first);
        }
      }
    };
    walk(id, undefined);
    return links;
  };

  if (!byId.has(graph.entryNodeId)) return { nodes: [], links: [] };
  const roots = shown(graph.entryNodeId) ? [graph.entryNodeId] : reach(graph.entryNodeId).map((link) => link.to);

  // Depth-first from the roots: the order Nodes are found seeds their order in
  // a row, and a step to a Node still being walked is a step back.
  const order: string[] = [];
  const finished: string[] = [];
  const links: StoryLink[] = [];
  const state = new Map<string, "walking" | "done">();
  const visit = (id: string) => {
    state.set(id, "walking");
    order.push(id);
    for (const link of reach(id)) {
      const target = state.get(link.to);
      if (target === "walking") continue;
      links.push(link);
      if (!target) visit(link.to);
    }
    state.set(id, "done");
    finished.push(id);
  };
  for (const root of roots) if (!state.has(root)) visit(root);

  // Each Node sits one row below the lowest Node that leads to it.
  const rows = new Map<string, number>();
  for (const id of [...finished].reverse()) {
    const above = links.filter((link) => link.to === id).map((link) => rows.get(link.from) ?? 0);
    rows.set(id, above.length ? Math.max(...above) + 1 : 0);
  }
  const rowCount = Math.max(0, ...rows.values()) + 1;
  const grid: string[][] = Array.from({ length: rowCount }, () => []);
  for (const id of order) grid[rows.get(id)!]!.push(id);

  // Twice down the rows, sort each row by where the Nodes leading to it sit,
  // so branches spread under their Node and lines cross less.
  const offset = (id: string) => {
    const row = grid[rows.get(id)!]!;
    return row.indexOf(id) - (row.length - 1) / 2;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (const row of grid.slice(1)) {
      const weight = new Map(row.map((id) => {
        const above = links.filter((link) => link.to === id).map((link) => offset(link.from));
        return [id, above.reduce((sum, value) => sum + value, 0) / Math.max(1, above.length)];
      }));
      row.sort((left, right) => weight.get(left)! - weight.get(right)!);
    }
  }

  return {
    nodes: order.map((id) => {
      const node = byId.get(id)!;
      const row = grid[rows.get(id)!]!;
      return {
        id,
        label: node.story?.label ?? node.title,
        row: rows.get(id)!,
        column: row.indexOf(id),
        rowSize: row.length,
        ending: isPlayableStoryEnding(node),
      };
    }),
    links,
  };
}

/** The laid-out story with what the player has seen, or with all of it seen. */
export function playableStoryMap(layout: PlayableStoryLayout, seen: PlayableSeen | "all"): PlayableStoryMap {
  const all = seen === "all";
  return {
    nodes: layout.nodes.map((node) => ({ ...node, seen: all || Object.hasOwn(seen.nodes, node.id) })),
    edges: layout.links.map((link) => ({
      from: link.from,
      to: link.to,
      seen: all || (Object.hasOwn(seen.edges, link.via) && Object.hasOwn(seen.nodes, link.to)),
    })),
  };
}

function isTimes(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((time) => typeof time === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
