import { describe, expect, it } from "vitest";
import {
  addPlayableNodeAsset,
  addPlayableShellAsset,
  deletePlayableSignal,
  parsePreviewStateInput,
  playableAssetId,
  playableAssetType,
  playableRuntimeKey,
  playableThumbnailHash,
  playableStateType,
  removePlayableNodeAsset,
  removePlayableShellAsset,
  renamePlayableSignal,
  setPlayableSignalLabel,
  setPlayableDestination,
  setPlayableSignalTarget,
} from "../src/shared/playable-editor.js";
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
      id: "menu:start",
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
    expect(added.graph.nodes.find((node) => node.id === "lobby")?.assets).toEqual(["door"]);

    const reused = addPlayableNodeAsset(added.graph, "archive", {
      name: "theme.mp3",
      type: "audio",
      source: { kind: "library", assetId: "library-theme" },
    });
    expect(reused.assetId).toBe("theme");
    expect(Object.keys(reused.graph.assets)).toEqual(["background", "theme", "door"]);
    expect(graph.nodes.find((node) => node.id === "lobby")?.assets).toEqual([]);
  });

  it("drops an Asset from the graph only when nothing declares it", () => {
    const graph = createNodeGraphFixture();
    const removed = removePlayableNodeAsset(graph, "menu", "background");
    expect(removed.nodes[0]!.assets).toEqual([]);
    expect(removed.assets.background).toBeUndefined();

    const shared = addPlayableNodeAsset(graph, "lobby", { name: "theme", ...graph.assets.theme! }).graph;
    const kept = removePlayableNodeAsset(shared, "lobby", "theme");
    expect(kept.assets.theme).toBeDefined();
  });

  it("keeps the preview running across title and label edits", () => {
    const graph = createNodeGraphFixture();
    const definition = { version: 1, graph, compiled: {}, graphSignature: "a" } as unknown as NodePlayerDefinition;
    const renamed = setPlayableSignalLabel({ ...graph, title: "Renamed", nodes: graph.nodes.map((node) => ({ ...node, title: `${node.title}!` })) }, "menu", "start", "Go");

    expect(playableRuntimeKey({ ...definition, graph: renamed, graphSignature: "b" })).toBe(playableRuntimeKey(definition));
    const retargeted = setPlayableSignalTarget(graph, "menu", "start", "archive");
    expect(playableRuntimeKey({ ...definition, graph: retargeted })).not.toBe(playableRuntimeKey(definition));
  });

  it("parses Preview State input by the key's initial type", () => {
    expect(parsePreviewStateInput("Ada", "")).toEqual({ value: "Ada" });
    expect(parsePreviewStateInput("3", 0)).toEqual({ value: 3 });
    expect(parsePreviewStateInput("three", 0)).toEqual({ error: "Enter a number." });
    expect(parsePreviewStateInput("true", false)).toEqual({ value: true });
    expect(parsePreviewStateInput('["key"]', [])).toEqual({ value: ["key"] });
    expect(parsePreviewStateInput("{", {})).toEqual({ error: "Enter valid JSON." });
  });

  it("hashes what a Node thumbnail shows", () => {
    const graph = createNodeGraphFixture();
    const surface = (id: string) => ({ id, html: `<main>${id}</main>`, css: "main {}", javascript: "export function mount() {}", inputs: [] });
    const definition = {
      version: 1,
      graph,
      compiled: { nodes: { menu: surface("menu"), lobby: surface("lobby") }, shell: surface("shell") },
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
    const shell = { ...definition, compiled: { ...definition.compiled, shell: { ...surface("shell"), html: "<nav>New</nav>" } } };
    expect(playableThumbnailHash(shell, "menu")).not.toBe(hash);
    const background = { ...graph, assets: { ...graph.assets, background: { type: "image" as const, source: { kind: "workspace" as const, path: "assets/other.webp" } } } };
    expect(playableThumbnailHash({ ...definition, graph: background }, "menu")).not.toBe(hash);
    expect(playableThumbnailHash({ ...definition, graph: { ...graph, viewport: { width: 720, height: 1280 } } }, "menu")).not.toBe(hash);
  });
});

describe("Playable project editing", () => {
  it("sets, retargets, and removes a Destination", () => {
    const destinations = { home: "menu" };
    expect(setPlayableDestination(destinations, "archive", "archive")).toEqual({ home: "menu", archive: "archive" });
    expect(setPlayableDestination(destinations, "home", "lobby")).toEqual({ home: "lobby" });
    expect(setPlayableDestination(destinations, "home", undefined)).toEqual({});
    expect(destinations).toEqual({ home: "menu" });
  });

  it("adds and removes Shell assets", () => {
    const graph = createNodeGraphFixture();
    const added = addPlayableShellAsset(graph, { name: "Rain", type: "audio", source: { kind: "workspace", path: "assets/rain.mp3" } });

    expect(added.graph.shell?.assets).toEqual(["theme", added.assetId]);
    expect(added.graph.assets[added.assetId]).toMatchObject({ type: "audio" });
    expect(graph.shell?.assets).toEqual(["theme"]);
    expect(removePlayableShellAsset(added.graph, added.assetId).shell?.assets).toEqual(["theme"]);
  });

  it("infers the State type shown for a key", () => {
    expect(["", 0, false, [], {}, null].map((value) => playableStateType(value))).toEqual(["text", "number", "boolean", "list", "object", "null"]);
  });
});
