import { describe, expect, it } from "vitest";
import { deletePlayableSignal, renamePlayableSignal } from "../src/shared/playable-editor.js";
import { createPlayableGraphFixture } from "./playable-fixture.js";

describe("Playable editor graph changes", () => {
  it("renames a Signal and preserves its connected Edge", () => {
    const graph = createPlayableGraphFixture();
    const renamed = renamePlayableSignal(graph, "menu", "start", "begin");

    expect(renamed.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "begin", label: "Start" });
    expect(renamed.edges.find((edge) => edge.source.nodeId === "menu")?.source.signal)
      .toBe("begin");
    expect(graph.nodes.find((node) => node.id === "menu")?.signals)
      .toContainEqual({ id: "start", label: "Start" });
  });

  it("removes an Edge only when its Signal is explicitly deleted", () => {
    const graph = createPlayableGraphFixture();
    const updated = deletePlayableSignal(graph, "menu", "start");

    expect(updated.nodes.find((node) => node.id === "menu")?.signals).not.toContainEqual(
      expect.objectContaining({ id: "start" }),
    );
    expect(updated.edges.some((edge) => edge.source.nodeId === "menu" && edge.source.signal === "start"))
      .toBe(false);
  });
});
