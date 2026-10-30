import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { playablePreset } from "../src/daemon/playable-presets.js";
import type { NodeGraph, PlayableEdge, PlayableNode } from "../src/shared/playable-nodes.js";
import { parsePlayableSeen } from "../src/shared/playable-seen.js";

interface StoryLayout {
  nodes: { id: string; label: string; row: number; column: number; rowSize: number; ending: boolean }[];
  links: { from: string; to: string; via: string }[];
}
type LayoutOptions = { offMap?: Set<string>; labels?: Record<string, string>; isEnding?: (node: PlayableNode) => boolean };

/** The Story map Template's own layout.js, as a new Story map Scene gets it. */
const layoutStory = await (async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-story-layout-"));
  try {
    const file = path.join(directory, "layout.mjs");
    await writeFile(file, playablePreset("story-map")!.source("Story map", "story-map").files!["layout.js"]!);
    return (await import(pathToFileURL(file).href)).layoutStory as (graph: NodeGraph, options?: LayoutOptions) => StoryLayout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();
const byExits = (scene: PlayableNode) => !scene.signals.some((signal) => signal.role !== "navigation");

function node(id: string, signals: string[] = []): PlayableNode {
  return {
    id,
    title: id.toUpperCase(),
    source: { html: `nodes/${id}/index.html`, css: `nodes/${id}/style.css`, javascript: `nodes/${id}/node.js` },
    assets: [],
    signals: signals.map((signal) => ({ id: signal, label: signal })),
  };
}

/** `from.signal>to`, with `~` for an edge with Allow Back. */
function edges(...specs: string[]): PlayableEdge[] {
  return specs.map((spec) => {
    const [source, target] = spec.split(">") as [string, string];
    const [nodeId, signal] = source.split(".") as [string, string];
    const push = target.startsWith("~");
    return {
      id: `${nodeId}-${signal}`,
      source: { nodeId, signal },
      targetNodeId: push ? target.slice(1) : target,
      mode: push ? "push" : "replace",
    };
  });
}

function graph(nodes: PlayableNode[], graphEdges: PlayableEdge[], entryNodeId = nodes[0]!.id): NodeGraph {
  return {
    version: 1,
    title: "Story",
    viewport: { width: 1280, height: 720 },
    entryNodeId,
    initialState: {},
    assets: {},
    nodes,
    edges: graphEdges,
  };
}

/** Each row of the layout, left to right. */
function rows(story: NodeGraph, options?: LayoutOptions): string[][] {
  const layout = layoutStory(story, options);
  const result: string[][] = [];
  for (const entry of layout.nodes) (result[entry.row] ??= [])[entry.column] = entry.id;
  return result;
}

describe("the Story map Template's layout", () => {
  it("branches in Signal order and puts a merge below both branches", () => {
    const story = graph(
      [node("a", ["left", "right"]), node("b", ["next"]), node("c", ["next"]), node("d")],
      edges("a.left>b", "a.right>c", "b.next>d", "c.next>d"),
    );

    expect(rows(story)).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(layoutStory(story).nodes.find((entry) => entry.id === "b")).toMatchObject({ row: 1, column: 0, rowSize: 2 });
  });

  it("starts after a menu off the map and joins the steps through Scenes off it", () => {
    const story = graph(
      [node("menu", ["start"]), node("a", ["next"]), node("bridge", ["next"]), node("b")],
      edges("menu.start>a", "a.next>bridge", "bridge.next>b"),
    );
    const offMap = new Set(["menu", "bridge"]);

    expect(rows(story, { offMap })).toEqual([["a"], ["b"]]);
    expect(layoutStory(story, { offMap }).links).toEqual([{ from: "a", to: "b", via: "a-next" }]);
  });

  it("leaves out side screens, navigation Exits, and steps back up the story", () => {
    const lobby = node("lobby", ["home", "archive", "qte"]);
    lobby.signals[0]!.role = "navigation";
    const story = graph(
      [lobby, node("archive"), node("qte", ["fail", "win"]), node("end"), node("home")],
      edges("lobby.home>home", "lobby.archive>~archive", "lobby.qte>qte", "qte.fail>lobby", "qte.win>end"),
    );

    expect(rows(story)).toEqual([["lobby"], ["qte"], ["end"]]);
  });

  it("is empty when the Start is missing, and names and judges Scenes as the Scene's code says", () => {
    expect(layoutStory(graph([node("a")], [], "gone")).nodes).toEqual([]);
    expect(layoutStory(graph([node("a")], []), { labels: { a: "The end" }, isEnding: byExits }).nodes[0]).toMatchObject({ label: "The end", ending: true });
    expect(layoutStory(graph([node("a")], [])).nodes[0]).toMatchObject({ label: "A", ending: false });
  });
});

describe("what the player has seen", () => {
  it("starts an unreadable seen record over", () => {
    expect(parsePlayableSeen({ version: 1, nodes: { a: 1 }, edges: {} })).toEqual({ version: 1, nodes: {}, edges: {} });
    expect(parsePlayableSeen("nope")).toEqual({ version: 1, nodes: {}, edges: {} });
    expect(parsePlayableSeen({ version: 1, nodes: { a: "t" }, edges: {} }).nodes).toEqual({ a: "t" });
  });
});
