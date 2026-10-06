import { describe, expect, it } from "vitest";
import {
  buildCodebase,
  nodeIdForIssuePath,
  toFlowEdge,
  toPlayableEdge,
  uniqueNodeId,
  type GraphMeta,
  type PlayableFlowNode,
} from "../src/renderer/playable-flow.js";
import type { NodeEditorLayout } from "../src/shared/playable-codebase.js";
import type { PlayableEdge, PlayableNode } from "../src/shared/playable-nodes.js";

function playableNode(id: string, signals: string[] = []): PlayableNode {
  return {
    id,
    title: id,
    source: {
      html: `nodes/${id}/index.html`,
      css: `nodes/${id}/style.css`,
      javascript: `nodes/${id}/node.js`,
    },
    assets: [],
    signals: signals.map((signal) => ({ id: signal, label: signal })),
  };
}

function flowNode(node: PlayableNode, position: { x: number; y: number }): PlayableFlowNode {
  return {
    id: node.id,
    type: "playable",
    position,
    data: { node, entry: false, ending: false, issues: [], connected: {}, failed: false },
  };
}

const META: GraphMeta = {
  version: 1,
  title: "Ash Club",
  viewport: { width: 1280, height: 720 },
  entryNodeId: "start",
  initialState: {},
  assets: {},
};

const LAYOUT: NodeEditorLayout = {
  version: 1,
  nodes: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  view: "canvas",
};

describe("playable canvas serialization", () => {
  it("writes the graph from canvas state with rounded positions", () => {
    const nodes = [
      flowNode(playableNode("start", ["begin"]), { x: 80.4, y: 180.6 }),
      flowNode(playableNode("carriage"), { x: 520, y: 180 }),
    ];
    const edges = [toFlowEdge({
      id: "start-begin",
      source: { nodeId: "start", signal: "begin" },
      targetNodeId: "carriage",
      mode: "replace",
    })];

    const codebase = buildCodebase(META, nodes, edges, LAYOUT, "code");

    expect(codebase.graph.title).toBe("Ash Club");
    expect(codebase.graph.nodes.map((node) => node.id)).toEqual(["start", "carriage"]);
    expect(codebase.graph.edges).toEqual([{
      id: "start-begin",
      source: { nodeId: "start", signal: "begin" },
      targetNodeId: "carriage",
      mode: "replace",
    }]);
    expect(codebase.editorLayout.nodes).toEqual({ start: { x: 80, y: 181 }, carriage: { x: 520, y: 180 } });
    expect(codebase.editorLayout.view).toBe("code");
  });

  it("round-trips both edge modes and marks push edges on the canvas", () => {
    const edge: PlayableEdge = {
      id: "start-inspect",
      source: { nodeId: "start", signal: "inspect" },
      targetNodeId: "archive",
      mode: "push",
    };

    const flowEdge = toFlowEdge(edge);

    expect(flowEdge).toMatchObject({ label: "↩ Back", className: "playable-edge-push", sourceHandle: "inspect" });
    expect(toPlayableEdge(flowEdge)).toEqual(edge);
    // A replace edge stays undecorated so only push edges read as a stack push.
    const replace = toFlowEdge({ ...edge, mode: "replace" });
    expect(replace.label).toBeUndefined();
    expect(toPlayableEdge(replace)?.mode).toBe("replace");
    // An edge dropped on a Node body has no Signal, so there is nothing to store.
    expect(toPlayableEdge({ ...flowEdge, sourceHandle: undefined })).toBeUndefined();
  });

  it("slugifies a copied Node ID and keeps it unique", () => {
    const taken = new Set(["carriage", "carriage-2"]);
    expect(uniqueNodeId("The Carriage", new Set())).toBe("the-carriage");
    expect(uniqueNodeId("carriage", taken)).toBe("carriage-3");
    expect(uniqueNodeId("../escape!", new Set())).toBe("escape");
    expect(uniqueNodeId("!!!", new Set())).toBe("node");
  });

  it("attributes a compiler issue to the Node that owns the file", () => {
    const nodes = [flowNode(playableNode("start"), { x: 0, y: 0 })];
    expect(nodeIdForIssuePath("nodes/start/node.js", nodes)).toBe("start");
    expect(nodeIdForIssuePath("nodes/start/extra/helper.js", nodes)).toBe("start");
    expect(nodeIdForIssuePath("shared/components/menu.js", nodes)).toBeUndefined();
  });
});
