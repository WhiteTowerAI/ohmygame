import { describe, expect, it } from "vitest";
import {
  playableDestinationNode,
  playableEdgeForSignal,
  playableNodeById,
  playableOutgoingEdges,
} from "../src/shared/playable-graph.js";
import { PLAYABLE_GRAPH_SCHEMA } from "../src/shared/playable-graph-schema.js";
import {
  isPlayableGraph,
  validatePlayableGraph,
} from "../src/shared/playable-graph-validation.js";
import type { PlayableGraph } from "../src/shared/playable-nodes.js";
import {
  createPlayableGraphFixture,
  PLAYABLE_FIXTURE_FILES,
} from "./playable-fixture.js";

describe("Playable Graph contract", () => {
  it("exports a standalone JSON Schema and accepts a valid graph", () => {
    const graph = createPlayableGraphFixture();

    expect(PLAYABLE_GRAPH_SCHEMA.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(validatePlayableGraph(graph)).toEqual({ ok: true, issues: [] });
    expect(isPlayableGraph(graph)).toBe(true);
  });

  it("rejects malformed graph fields before cross-reference validation", () => {
    const graph = createPlayableGraphFixture() as PlayableGraph & {
      unexpected?: boolean;
    };
    graph.unexpected = true;
    graph.nodes[0]!.source.html = "C:outside.html";
    graph.edges[0]!.mode = "overlay" as "replace";

    const result = validatePlayableGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.issues.every((item) => item.code === "schema")).toBe(true);
    expect(result.issues.some((item) => item.path === "/unexpected")).toBe(
      true,
    );
    expect(
      result.issues.some((item) => item.path.includes("/source/html")),
    ).toBe(true);
    expect(result.issues.some((item) => item.path.includes("/mode"))).toBe(
      true,
    );
  });

  it("reports duplicate IDs and invalid graph references", () => {
    const graph = createPlayableGraphFixture();
    graph.nodes.push(structuredClone(graph.nodes[0]!));
    graph.nodes[0]!.signals.push({ id: "start", label: "Duplicate start" });
    graph.edges.push({
      id: "start-game",
      source: { nodeId: "missing", signal: "unknown" },
      targetNodeId: "missing",
      mode: "replace",
    });
    graph.destinations.broken = "missing";

    const result = validatePlayableGraph(graph);

    expect(
      result.issues.filter((item) => item.code === "duplicate-id").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      result.issues.some(
        (item) =>
          item.path === "/destinations/broken" && item.code === "missing-node",
      ),
    ).toBe(true);
    expect(
      result.issues.some(
        (item) =>
          item.path.endsWith("/source/nodeId") && item.code === "missing-node",
      ),
    ).toBe(true);
    expect(
      result.issues.some(
        (item) =>
          item.path.endsWith("/targetNodeId") && item.code === "missing-node",
      ),
    ).toBe(true);
  });

  it("validates signal routes, asset dependencies, and referenced files", () => {
    const graph = createPlayableGraphFixture();
    graph.nodes[0]!.assets.push("missing-asset");
    graph.shell!.assets.push("missing-shell-asset");
    graph.edges[0]!.source.signal = "undeclared";
    graph.edges.push({
      id: "duplicate-route",
      source: { nodeId: "menu", signal: "inspect" },
      targetNodeId: "lobby",
      mode: "replace",
    });
    const files = new Set([
      "shell/index.html",
      "shell/style.css",
      "shell/shell.js",
      "nodes/menu/index.html",
      "nodes/menu/style.css",
      "nodes/menu/node.js",
      "nodes/lobby/index.html",
      "nodes/lobby/style.css",
      "nodes/lobby/node.js",
      "nodes/archive/index.html",
      "nodes/archive/style.css",
    ]);

    const result = validatePlayableGraph(graph, { availableFiles: files });

    expect(result.issues.some((item) => item.code === "missing-signal")).toBe(
      true,
    );
    expect(result.issues.some((item) => item.code === "duplicate-route")).toBe(
      true,
    );
    expect(
      result.issues.filter((item) => item.code === "missing-asset"),
    ).toHaveLength(2);
    expect(
      result.issues.some(
        (item) =>
          item.code === "missing-file" &&
          item.message.includes("nodes/archive/node.js"),
      ),
    ).toBe(true);
    expect(
      result.issues.some(
        (item) =>
          item.code === "missing-file" &&
          item.message.includes("assets/background.webp"),
      ),
    ).toBe(true);
  });

  it("allows unconnected signals in drafts but requires them for publish", () => {
    const graph = createPlayableGraphFixture();
    graph.edges = graph.edges.filter(
      (edge) => edge.source.signal !== "inspect",
    );

    expect(validatePlayableGraph(graph, { mode: "draft" }).ok).toBe(true);
    expect(
      validatePlayableGraph(graph, {
        mode: "publish",
        availableFiles: PLAYABLE_FIXTURE_FILES,
      }).issues,
    ).toContainEqual(
      expect.objectContaining({
        code: "unconnected-signal",
        message: 'Signal "menu.inspect" must be connected before publishing.',
      }),
    );
  });

  it("requires a workspace file inventory for publish validation", () => {
    const graph = createPlayableGraphFixture();
    const options = { mode: "publish" } as unknown as Parameters<
      typeof validatePlayableGraph
    >[1];

    expect(validatePlayableGraph(graph, options).issues).toContainEqual(
      expect.objectContaining({ code: "file-list-required" }),
    );
  });

  it("rejects graphs above the runtime resource limits", () => {
    const graph = createPlayableGraphFixture();
    graph.nodes = Array.from({ length: 501 }, (_, index) => ({
      ...structuredClone(graph.nodes[0]!),
      id: `node-${index}`,
    }));

    const result = validatePlayableGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "schema", path: "/nodes" }));
  });

  it("provides side-effect-free graph lookups", () => {
    const graph = createPlayableGraphFixture();

    expect(playableNodeById(graph, "menu")?.title).toBe("Main menu");
    expect(playableNodeById(graph, "missing")).toBeUndefined();
    expect(playableEdgeForSignal(graph, "menu", "inspect")?.mode).toBe("push");
    expect(playableOutgoingEdges(graph, "menu")).toHaveLength(2);
    expect(playableDestinationNode(graph, "archive")?.id).toBe("archive");
    expect(playableDestinationNode(graph, "missing")).toBeUndefined();
  });
});
