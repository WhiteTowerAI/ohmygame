import { describe, expect, it } from "vitest";
import {
  createPlayableNavigation,
  navigatePlayableBack,
  navigatePlayableSignal,
  PlayableNavigationError,
} from "../src/shared/playable-navigation.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

describe("Playable navigation", () => {
  it("starts at the Entry Node and follows replace edges", () => {
    const graph = createNodeGraphFixture();
    const initial = createPlayableNavigation(graph);
    const next = navigatePlayableSignal(graph, initial, "start");

    expect(initial).toEqual({ currentNodeId: "menu", backStack: [] });
    expect(next).toEqual({ currentNodeId: "lobby", backStack: [] });
  });

  it("pushes return locations and remounts them on back", () => {
    const graph = createNodeGraphFixture();
    const initial = createPlayableNavigation(graph);
    const archive = navigatePlayableSignal(graph, initial, "inspect");
    const returned = navigatePlayableBack(archive);

    expect(archive).toEqual({ currentNodeId: "archive", backStack: ["menu"] });
    expect(returned).toEqual(initial);
    expect(archive).toEqual({ currentNodeId: "archive", backStack: ["menu"] });
  });

  it("routes a shared component's Signal by the Scene that shows it", () => {
    const graph = createNodeGraphFixture();
    const initial = createPlayableNavigation(graph);
    const lobby = navigatePlayableSignal(graph, initial, "start");
    const archive = navigatePlayableSignal(graph, lobby, "archive");

    expect(archive).toEqual({ currentNodeId: "archive", backStack: [] });
    expect(navigatePlayableSignal(graph, archive, "home")).toEqual({ currentNodeId: "menu", backStack: [] });
    expect(() => navigatePlayableSignal(graph, archive, "archive"))
      .toThrowError(expect.objectContaining({ code: "unknown-signal" }));
  });

  it("returns actionable errors for invalid navigation requests", () => {
    const graph = createNodeGraphFixture();
    const initial = createPlayableNavigation(graph);
    graph.edges = graph.edges.filter(
      (edge) => edge.source.signal !== "inspect",
    );

    expect(() =>
      navigatePlayableSignal(graph, initial, "not-declared"),
    ).toThrowError(expect.objectContaining({ code: "unknown-signal" }));
    expect(() =>
      navigatePlayableSignal(graph, initial, "inspect"),
    ).toThrowError(expect.objectContaining({ code: "unconnected-signal" }));
    graph.edges = graph.edges.map((edge) => edge.id === "start-game" ? { ...edge, mode: "overlay" as "replace" } : edge);
    expect(() =>
      navigatePlayableSignal(graph, initial, "start"),
    ).toThrowError(expect.objectContaining({ code: "invalid-mode" }));
    expect(() => navigatePlayableBack(initial)).toThrowError(
      PlayableNavigationError,
    );
  });

  it("rejects a graph whose Entry Node is missing", () => {
    const graph = createNodeGraphFixture();
    graph.entryNodeId = "missing";

    expect(() => createPlayableNavigation(graph)).toThrowError(
      expect.objectContaining({ code: "unknown-node" }),
    );
  });
});
