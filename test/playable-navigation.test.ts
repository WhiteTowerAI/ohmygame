import { describe, expect, it } from "vitest";
import {
  createPlayableNavigation,
  navigatePlayableBack,
  navigatePlayableSignal,
  openPlayableDestination,
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

  it("opens Shell destinations with explicit navigation modes", () => {
    const graph = createNodeGraphFixture();
    const initial = createPlayableNavigation(graph);

    expect(openPlayableDestination(graph, initial, "archive")).toEqual({
      currentNodeId: "archive",
      backStack: [],
    });
    expect(openPlayableDestination(graph, initial, "archive", "push")).toEqual({
      currentNodeId: "archive",
      backStack: ["menu"],
    });
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
    expect(() =>
      openPlayableDestination(graph, initial, "missing"),
    ).toThrowError(expect.objectContaining({ code: "unknown-destination" }));
    expect(() =>
      openPlayableDestination(
        graph,
        initial,
        "archive",
        "overlay" as "replace",
      ),
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
