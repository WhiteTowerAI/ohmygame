import { describe, expect, it } from "vitest";
import {
  addPlayableNodeAsset,
  deletePlayableSignal,
  describePlayableValue,
  playableAssetId,
  playableAssetType,
  playableRuntimeKey,
  playableThumbnailHash,
  removePlayableNodeAsset,
  renamePlayableSignal,
  playableEdgeId,
  setPlayableSignalLabel,
  setPlayableSignalRole,
  setPlayableSignalTarget,
} from "../src/shared/playable-editor.js";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

describe("Playable editor graph changes", () => {
  it("marks an Exit as navigation and back as part of the story", () => {
    const graph = createNodeGraphFixture();
    const marked = setPlayableSignalRole(graph, "menu", "start", true);
    expect(marked.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "start", label: "Start", role: "navigation" });
    expect(marked.edges).toEqual(graph.edges);

    const story = setPlayableSignalRole(marked, "menu", "start", false);
    expect(story.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "start", label: "Start" });
    expect(graph.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "start", label: "Start" });
  });

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

  it("points a Signal at a new target, keeping its Edge ID and mode", () => {
    const graph = createNodeGraphFixture();
    const retargeted = setPlayableSignalTarget(graph, "menu", "inspect", "lobby");

    expect(retargeted.edges.filter((edge) => edge.source.signal === "inspect")).toEqual([{
      id: "inspect-archive",
      source: { nodeId: "menu", signal: "inspect" },
      targetNodeId: "lobby",
      mode: "push",
    }]);
    const disconnected = setPlayableSignalTarget(graph, "menu", "start", undefined);
    expect(disconnected.edges.some((edge) => edge.source.signal === "start")).toBe(false);
    const reconnected = setPlayableSignalTarget(disconnected, "menu", "start", "archive");
    expect(reconnected.edges).toContainEqual({
      id: "menu-start",
      source: { nodeId: "menu", signal: "start" },
      targetNodeId: "archive",
      mode: "replace",
    });
    expect(setPlayableSignalTarget(graph, "menu", "start", "missing").edges.some((edge) => edge.source.signal === "start")).toBe(false);
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

  it("keeps the preview running across title and label edits", () => {
    const graph = createNodeGraphFixture();
    const definition = { version: 1, graph, compiled: {}, graphSignature: "a" } as unknown as NodePlayerDefinition;
    const renamed = setPlayableSignalLabel({ ...graph, title: "Renamed", nodes: graph.nodes.map((node) => ({ ...node, title: `${node.title}!` })) }, "menu", "start", "Go");

    expect(playableRuntimeKey({ ...definition, graph: renamed, graphSignature: "b" })).toBe(playableRuntimeKey(definition));
    const retargeted = setPlayableSignalTarget(graph, "menu", "start", "archive");
    expect(playableRuntimeKey({ ...definition, graph: retargeted })).not.toBe(playableRuntimeKey(definition));
  });

  it("hashes what a Node thumbnail shows", () => {
    const graph = createNodeGraphFixture();
    const surface = (id: string) => ({ id, html: `<main>${id}</main>`, css: "main {}", javascript: "export function mount() {}", inputs: [] });
    const definition = {
      version: 1,
      graph,
      compiled: { nodes: { menu: surface("menu"), lobby: surface("lobby") } },
      graphSignature: "a",
    } as unknown as NodePlayerDefinition;
    const hash = playableThumbnailHash(definition, "menu")!;

    expect(hash).toMatch(/^[0-9a-f]{14}$/);
    expect(playableThumbnailHash(definition, "archive")).toBeUndefined();
    expect(playableThumbnailHash(definition, "lobby")).not.toBe(hash);
    const renamed = { ...graph, title: "Renamed", nodes: graph.nodes.map((node) => ({ ...node, title: `${node.title}!` })) };
    expect(playableThumbnailHash({ ...definition, graph: renamed, graphSignature: "b" }, "menu")).toBe(hash);
    const edited = { ...definition, compiled: { ...definition.compiled, nodes: { ...definition.compiled.nodes, menu: { ...surface("menu"), css: "main { color: red; }" } } } };
    expect(playableThumbnailHash(edited, "menu")).not.toBe(hash);
    const otherNode = { ...definition, compiled: { ...definition.compiled, nodes: { ...definition.compiled.nodes, lobby: { ...surface("lobby"), html: "<nav>New</nav>" } } } };
    expect(playableThumbnailHash(otherNode, "menu")).toBe(hash);
    const background = { ...graph, assets: { ...graph.assets, background: { type: "image" as const, source: { kind: "workspace" as const, path: "assets/other.webp" } } } };
    expect(playableThumbnailHash({ ...definition, graph: background }, "menu")).not.toBe(hash);
    expect(playableThumbnailHash({ ...definition, graph: { ...graph, viewport: { width: 720, height: 1280 } } }, "menu")).not.toBe(hash);
  });
});

describe("Playable project editing", () => {
  it("gives new edges IDs that graph.json accepts", () => {
    const graph = createNodeGraphFixture();
    const connected = setPlayableSignalTarget(graph, "archive", "missing-signal", "menu");
    expect(playableEdgeId([], "menu", "start")).toBe("menu-start");
    expect(playableEdgeId([{ id: "menu-start" }], "menu", "start")).toBe("menu-start-2");
    const disconnected = setPlayableSignalTarget(graph, "menu", "start", undefined);
    const reconnected = setPlayableSignalTarget(disconnected, "menu", "start", "archive");
    expect(reconnected.edges.find((edge) => edge.source.signal === "start")?.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(connected.edges.some((edge) => edge.id.includes(":"))).toBe(false);
  });

  it("edits the Signals a shared component emits on the Node that shows it", () => {
    const graph = createNodeGraphFixture();
    const renamed = setPlayableSignalLabel(graph, "lobby", "home", "Menu");
    expect(renamed.nodes.find((node) => node.id === "lobby")?.signals.find((signal) => signal.id === "home")?.label).toBe("Menu");
    expect(renamed.nodes.find((node) => node.id === "archive")?.signals.find((signal) => signal.id === "home")?.label).toBe("Home");
    const retargeted = setPlayableSignalTarget(graph, "lobby", "home", "archive", "push");
    expect(retargeted.edges.find((edge) => edge.source.nodeId === "lobby" && edge.source.signal === "home"))
      .toMatchObject({ targetNodeId: "archive", mode: "push" });
    expect(retargeted.edges.find((edge) => edge.source.nodeId === "archive" && edge.source.signal === "home"))
      .toMatchObject({ targetNodeId: "menu", mode: "replace" });
  });

});

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
