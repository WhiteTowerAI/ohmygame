import { describe, expect, it } from "vitest";
import {
  addPlayableNodeAsset,
  deletePlayableSignal,
  describePlayableValue,
  playableAssetId,
  playableAssetType,
  playableThumbnailHash,
  removePlayableNodeAsset,
  renamePlayableSignal,
  playableEdgeId,
  setPlayableSignalLabel,
} from "../src/shared/playable-editor.js";
import { rebasePlayableCodebase, samePlayableGraph, type NodeCodebase } from "../src/shared/playable-codebase.js";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

describe("Playable editor graph changes", () => {
  it("renames a Signal and preserves its connected Edge", () => {
    const graph = createNodeGraphFixture();
    const renamed = renamePlayableSignal(graph, "menu", "start", "begin");

    expect(renamed.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "begin", label: "Start" });
    expect(renamed.edges.find((edge) => edge.source.nodeId === "menu")?.source.signal)
      .toBe("begin");
    expect(graph.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "start", label: "Start" });
  });

  it("removes an Edge only when its Signal is explicitly deleted", () => {
    const graph = createNodeGraphFixture();
    const updated = deletePlayableSignal(graph, "menu", "start");

    expect(updated.nodes.find((node) => node.id === "menu")?.signals).not.toContainEqual(
      expect.objectContaining({ id: "start" }),
    );
    expect(updated.edges.some((edge) => edge.source.nodeId === "menu" && edge.source.signal === "start"))
      .toBe(false);
  });

  it("relabels a Signal without touching its ID or Edge", () => {
    const graph = createNodeGraphFixture();
    const updated = setPlayableSignalLabel(graph, "menu", "start", "  Begin  ");

    expect(updated.nodes[0]!.signals[0]).toEqual({ id: "start", label: "Begin" });
    expect(updated.edges).toEqual(graph.edges);
    expect(setPlayableSignalLabel(graph, "menu", "start", "   ")).toBe(graph);
  });

  it("derives readable, unique Asset IDs", () => {
    expect(playableAssetId("Rainy Street.PNG", new Set())).toBe("rainy-street");
    expect(playableAssetId("_bg.webp", new Set(["bg"]))).toBe("bg-2");
    expect(playableAssetId("???.mp3", new Set())).toBe("asset");
    expect(playableAssetType("image/webp")).toBe("image");
    expect(playableAssetType("audio")).toBe("audio");
    expect(playableAssetType("model")).toBeUndefined();
  });

  it("declares a Library Asset once and adds it to the Node", () => {
    const graph = createNodeGraphFixture();
    const added = addPlayableNodeAsset(graph, "lobby", {
      name: "Door.png",
      type: "image",
      source: { kind: "library", assetId: "library-door" },
    });

    expect(added.assetId).toBe("door");
    expect(added.graph.assets.door).toEqual({ type: "image", source: { kind: "library", assetId: "library-door" } });
    expect(added.graph.nodes.find((node) => node.id === "lobby")?.assets).toEqual(["theme", "door"]);

    const reused = addPlayableNodeAsset(added.graph, "archive", {
      name: "theme.mp3",
      type: "audio",
      source: { kind: "library", assetId: "library-theme" },
    });
    expect(reused.assetId).toBe("theme");
    expect(Object.keys(reused.graph.assets)).toEqual(["background", "theme", "door"]);
    expect(graph.nodes.find((node) => node.id === "lobby")?.assets).toEqual(["theme"]);
  });

  it("drops an Asset from the graph only when nothing declares it", () => {
    const graph = createNodeGraphFixture();
    const removed = removePlayableNodeAsset(graph, "menu", "background");
    expect(removed.nodes[0]!.assets).toEqual([]);
    expect(removed.assets.background).toBeUndefined();

    const shared = addPlayableNodeAsset(graph, "archive", { name: "theme", ...graph.assets.theme! }).graph;
    const kept = removePlayableNodeAsset(shared, "lobby", "theme");
    expect(kept.assets.theme).toBeDefined();
    expect(removePlayableNodeAsset(graph, "lobby", "theme").assets.theme).toBeUndefined();
  });

  it("takes a Node thumbnail's hash from the build", () => {
    const definition = {
      version: 1,
      graph: createNodeGraphFixture(),
      graphSignature: "a",
      hashes: { menu: "0123456789abcdef", lobby: "fedcba9876543210" },
    } satisfies NodePlayerDefinition;
    expect(playableThumbnailHash(definition, "menu")).toBe("0123456789abcdef");
    // A Scene whose files have a problem has no hash, so it is not captured.
    expect(playableThumbnailHash(definition, "archive")).toBeUndefined();
  });
});

describe("Playable project editing", () => {
  it("gives new edges IDs that graph.json accepts", () => {
    expect(playableEdgeId([], "menu", "start")).toBe("menu-start");
    expect(playableEdgeId([{ id: "menu-start" }], "menu", "start")).toBe("menu-start-2");
    expect(playableEdgeId([], "archive", "missing-signal")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("edits the Signals a shared component emits on the Node that shows it", () => {
    const graph = createNodeGraphFixture();
    const renamed = setPlayableSignalLabel(graph, "lobby", "home", "Menu");
    expect(renamed.nodes.find((node) => node.id === "lobby")?.signals.find((signal) => signal.id === "home")?.label).toBe("Menu");
    expect(renamed.nodes.find((node) => node.id === "archive")?.signals.find((signal) => signal.id === "home")?.label).toBe("Home");
  });

});

describe("rebasePlayableCodebase", () => {
  function codebase(): NodeCodebase {
    const graph = createNodeGraphFixture();
    return {
      graph,
      editorLayout: {
        version: 1,
        nodes: Object.fromEntries(graph.nodes.map((node, index) => [node.id, { x: index * 100, y: 0 }])),
        viewport: { x: 0, y: 0, zoom: 1 },
        view: "canvas",
      },
    };
  }

  it("keeps what the editor moved on the graph that changed on disk", () => {
    const base = codebase();
    const local = structuredClone(base);
    local.editorLayout.nodes.menu = { x: 640, y: 480 };
    local.editorLayout.viewport = { x: -200, y: 40, zoom: 0.5 };
    // The Agent renamed a Scene, removed one, and added one with its own position.
    const remote = structuredClone(base);
    const removed = remote.graph.nodes.at(-1)!;
    remote.graph.nodes = remote.graph.nodes.filter((node) => node !== removed);
    remote.graph.edges = remote.graph.edges.filter((edge) => edge.source.nodeId !== removed.id && edge.targetNodeId !== removed.id);
    delete remote.editorLayout.nodes[removed.id];
    remote.graph.nodes[0] = { ...remote.graph.nodes[0]!, title: "Renamed by the Agent" };
    remote.graph.nodes.push({ ...removed, id: "added", title: "Added by the Agent" });
    remote.editorLayout.nodes.added = { x: 900, y: 900 };
    remote.editorLayout.nodes.lobby = { x: 5, y: 5 };

    const rebased = rebasePlayableCodebase(base, local, remote);

    expect(rebased?.graph).toEqual(remote.graph);
    expect(rebased?.editorLayout).toEqual({
      ...local.editorLayout,
      nodes: { ...remote.editorLayout.nodes, menu: { x: 640, y: 480 } },
    });
  });

  it("compares graphs by what they hold, not by how the file is written", () => {
    const graph = createNodeGraphFixture();
    const reordered = JSON.parse(JSON.stringify(graph, Object.keys(flattenKeys(graph)).sort().reverse()));
    const renamed = { ...graph, title: `${graph.title}!` };

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(graph));
    expect(samePlayableGraph(graph, reordered)).toBe(true);
    expect(samePlayableGraph(graph, { ...graph, variables: undefined })).toBe(true);
    expect(samePlayableGraph(graph, renamed)).toBe(false);
    expect(samePlayableGraph(graph, { ...graph, nodes: graph.nodes.slice(1) })).toBe(false);
  });

  it("carries nothing when the editor changed the graph too", () => {
    const base = codebase();
    const local = structuredClone(base);
    local.graph.title = "Renamed in the editor";
    const remote = structuredClone(base);
    remote.graph.nodes[0] = { ...remote.graph.nodes[0]!, title: "Renamed by the Agent" };

    expect(rebasePlayableCodebase(base, local, remote)).toBeUndefined();
  });

  it("keeps remote layout changes when the editor only changes the graph", () => {
    const base = codebase(), local = structuredClone(base), remote = structuredClone(base);
    local.graph.title = "Local title";
    remote.editorLayout.nodes.menu = { x: 900, y: 700 };
    remote.editorLayout.viewport = { x: -40, y: 20, zoom: 0.5 };
    remote.editorLayout.view = "code";
    expect(rebasePlayableCodebase(base, local, remote)).toEqual({ graph: local.graph, editorLayout: remote.editorLayout });
  });

  it("combines independent layout changes even when the graph stays unchanged", () => {
    const base = codebase(), local = structuredClone(base), remote = structuredClone(base);
    local.editorLayout.nodes.menu = { x: 400, y: 400 };
    remote.editorLayout.nodes.lobby = { x: 900, y: 700 };
    remote.editorLayout.viewport = { x: -40, y: 20, zoom: 0.5 };
    const rebased = rebasePlayableCodebase(base, local, remote)!;
    expect(rebased.editorLayout.nodes.menu).toEqual(local.editorLayout.nodes.menu);
    expect(rebased.editorLayout.nodes.lobby).toEqual(remote.editorLayout.nodes.lobby);
    expect(rebased.editorLayout.viewport).toEqual(remote.editorLayout.viewport);
  });
});

/** Every key used anywhere in a JSON value. */
function flattenKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(value)) keys[key] = true;
    flattenKeys(child, keys);
  }
  return keys;
}

describe("describePlayableValue", () => {
  it("shows starting values in author words", () => {
    expect(describePlayableValue(true)).toBe("Yes");
    expect(describePlayableValue(false)).toBe("No");
    expect(describePlayableValue(3)).toBe("3");
    expect(describePlayableValue("")).toBe("empty");
    expect(describePlayableValue("Ada")).toBe('"Ada"');
    expect(describePlayableValue([])).toBe("empty");
    expect(describePlayableValue(["key"])).toBe("1 item");
    expect(describePlayableValue(["key", "map", "coin"])).toBe("3 items");
    expect(describePlayableValue({})).toBe("empty");
    expect(describePlayableValue({ name: "" })).toBe("1 field");
    expect(describePlayableValue(null)).toBe("nothing");
  });
});
