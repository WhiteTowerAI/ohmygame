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

  it("follows Shell Signals from whichever Node is current", () => {
    const graph = createNodeGraphFixture();
    const initial = createPlayableNavigation(graph);
    const lobby = navigatePlayableSignal(graph, initial, "start");

    expect(navigatePlayableSignal(graph, lobby, "archive", "shell")).toEqual({
      currentNodeId: "archive",
      backStack: [],
    });
    graph.edges = graph.edges.map((edge) => edge.id === "shell-archive" ? { ...edge, mode: "push" } : edge);
    expect(navigatePlayableSignal(graph, lobby, "archive", "shell")).toEqual({
      currentNodeId: "archive",
      backStack: ["lobby"],
    });
    expect(() => navigatePlayableSignal(graph, lobby, "home"))
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
    graph.edges = graph.edges.map((edge) => edge.id === "shell-home" ? { ...edge, mode: "overlay" as "replace" } : edge);
    expect(() =>
      navigatePlayableSignal(graph, initial, "home", "shell"),
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
