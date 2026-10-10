import { describe, expect, it } from "vitest";
import type { NodeGraph, PlayableEdge, PlayableNode } from "../src/shared/playable-nodes.js";
import {
  isPlayableStoryEnding,
  layoutPlayableStory,
  parsePlayableSeen,
  playableStoryMap,
  withPlayableStoryOption,
} from "../src/shared/playable-story-map.js";

function node(id: string, signals: string[] = [], extra: Partial<PlayableNode> = {}): PlayableNode {
  return {
    id,
    title: id.toUpperCase(),
    source: { html: `nodes/${id}/index.html`, css: `nodes/${id}/style.css`, javascript: `nodes/${id}/node.js` },
    assets: [],
    signals: signals.map((signal) => ({ id: signal, label: signal })),
    ...extra,
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
function rows(story: NodeGraph): string[][] {
  const layout = layoutPlayableStory(story);
  const result: string[][] = [];
  for (const entry of layout.nodes) (result[entry.row] ??= [])[entry.column] = entry.id;
  return result;
}

describe("layoutPlayableStory", () => {
  it("branches in Signal order and puts a merge below both branches", () => {
    const story = graph(
      [node("a", ["left", "right"]), node("b", ["next"]), node("c", ["next"]), node("d")],
      edges("a.left>b", "a.right>c", "b.next>d", "c.next>d"),
    );

    expect(rows(story)).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(layoutPlayableStory(story).nodes.find((entry) => entry.id === "b")).toMatchObject({ row: 1, column: 0, rowSize: 2 });
  });

  it("starts after a hidden menu and joins the steps through hidden Scenes", () => {
    const story = graph(
      [node("menu", ["start"], { story: { hidden: true } }), node("a", ["next"]), node("bridge", ["next"], { story: { hidden: true } }), node("b")],
      edges("menu.start>a", "a.next>bridge", "bridge.next>b"),
    );

    expect(rows(story)).toEqual([["a"], ["b"]]);
    expect(layoutPlayableStory(story).links).toEqual([{ from: "a", to: "b", via: ["a-next"] }]);
  });

  it("keeps one way between two Scenes, starting with every Exit that leads there", () => {
    const parallel = graph([node("a", ["left", "right"]), node("b")], edges("a.left>b", "a.right>b"));
    expect(layoutPlayableStory(parallel).links).toEqual([{ from: "a", to: "b", via: ["a-left", "a-right"] }]);

    const bridge = node("bridge", ["next"], { story: { hidden: true } });
    const direct = graph([node("a", ["left", "right"]), bridge, node("b")], edges("a.left>b", "a.right>bridge", "bridge.next>b"));
    expect(layoutPlayableStory(direct).links).toEqual([{ from: "a", to: "b", via: ["a-left", "a-right"] }]);

    const joined = graph([node("a", ["left", "right"]), bridge, node("b")], edges("a.left>bridge", "a.right>bridge", "bridge.next>b"));
    expect(layoutPlayableStory(joined).links).toEqual([{ from: "a", to: "b", via: ["a-left", "a-right"] }]);
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

  it("is empty when the Start is missing, and names Scenes by their story label", () => {
    expect(layoutPlayableStory(graph([node("a")], [], "gone")).nodes).toEqual([]);
    expect(layoutPlayableStory(graph([node("a", [], { story: { label: "The end" } })], [])).nodes[0]).toMatchObject({ label: "The end", ending: true });
  });
});

describe("playableStoryMap", () => {
  it("marks seen Scenes, and a way as seen once its first step was taken and its target seen", () => {
    const story = graph(
      [node("a", ["left", "right"]), node("b"), node("c")],
      edges("a.left>b", "a.right>c"),
    );
    const map = playableStoryMap(layoutPlayableStory(story), {
      version: 1,
      nodes: { a: "2026-10-06T00:00:00.000Z", b: "2026-10-06T00:01:00.000Z" },
      edges: { "a-left": "2026-10-06T00:01:00.000Z", "a-right": "2026-10-06T00:02:00.000Z" },
    });

    expect(map.nodes.map((entry) => [entry.id, entry.seen])).toEqual([["a", true], ["b", true], ["c", false]]);
    expect(map.edges).toEqual([
      { from: "a", to: "b", seen: true },
      { from: "a", to: "c", seen: false },
    ]);
  });

  it("marks a way as seen whichever of the Exits that lead there was taken", () => {
    const story = graph([node("a", ["left", "right"]), node("b")], edges("a.left>b", "a.right>b"));
    const layout = layoutPlayableStory(story);
    const nodes = { a: "2026-10-06T00:00:00.000Z", b: "2026-10-06T00:01:00.000Z" };

    expect(playableStoryMap(layout, { version: 1, nodes, edges: { "a-left": "2026-10-06T00:01:00.000Z" } }).edges).toEqual([{ from: "a", to: "b", seen: true }]);
    expect(playableStoryMap(layout, { version: 1, nodes, edges: { "a-right": "2026-10-06T00:01:00.000Z" } }).edges).toEqual([{ from: "a", to: "b", seen: true }]);
    expect(playableStoryMap(layout, { version: 1, nodes, edges: {} }).edges).toEqual([{ from: "a", to: "b", seen: false }]);
  });
});

describe("story options", () => {
  it("guesses an ending from Signals unless told", () => {
    const menu = node("menu", ["home"]);
    menu.signals[0]!.role = "navigation";
    expect(isPlayableStoryEnding(menu)).toBe(true);
    expect(isPlayableStoryEnding(node("scene", ["next"]))).toBe(false);
    expect(isPlayableStoryEnding(node("scene", ["next"], { story: { ending: true } }))).toBe(true);
  });

  it("stores only what differs from the guess", () => {
    const scene = node("scene", ["next"]);
    const ended = withPlayableStoryOption(scene, "ending", true);
    expect(ended.story).toEqual({ ending: true });
    expect(withPlayableStoryOption(ended, "ending", false)).toEqual(scene);
    expect(withPlayableStoryOption(scene, "hidden", true).story).toEqual({ hidden: true });
    expect(withPlayableStoryOption({ ...scene, story: { hidden: true, label: "Night" } }, "hidden", false).story).toEqual({ label: "Night" });
  });

  it("starts an unreadable seen record over", () => {
    expect(parsePlayableSeen({ version: 1, nodes: { a: 1 }, edges: {} })).toEqual({ version: 1, nodes: {}, edges: {} });
    expect(parsePlayableSeen("nope")).toEqual({ version: 1, nodes: {}, edges: {} });
    expect(parsePlayableSeen({ version: 1, nodes: { a: "t" }, edges: {} }).nodes).toEqual({ a: "t" });
  });
});
