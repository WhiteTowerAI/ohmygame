import { describe, expect, it } from "vitest";
import {
  createStoryDocument,
  getNextNode,
  getOutgoingEdge,
  getStartNode,
  isStoryDocument,
  replaceOutgoingEdge,
  validatePlayableChapter,
} from "../src/shared/story.js";

describe("story documents", () => {
  it("creates one chapter with one start node", () => {
    const story = createStoryDocument();
    expect(isStoryDocument(story)).toBe(true);
    expect(story.chapters).toHaveLength(1);
    expect(story.chapters[0]?.nodes).toEqual([expect.objectContaining({ type: "start" })]);
  });

  it("rejects missing starts, duplicate ids, and dangling edges", () => {
    const missingStart = createStoryDocument();
    missingStart.chapters[0]!.nodes = [];
    expect(isStoryDocument(missingStart)).toBe(false);

    const duplicate = createStoryDocument();
    duplicate.chapters[0]!.nodes.push({ ...duplicate.chapters[0]!.nodes[0]! });
    expect(isStoryDocument(duplicate)).toBe(false);

    const dangling = createStoryDocument();
    dangling.chapters[0]!.edges.push({ id: "edge", source: dangling.chapters[0]!.nodes[0]!.id, target: "missing" });
    expect(isStoryDocument(dangling)).toBe(false);

    const duplicateOutput = createStoryDocument();
    const duplicateStart = duplicateOutput.chapters[0]!.nodes[0]!;
    duplicateOutput.chapters[0]!.nodes.push(
      { id: "ending-a", type: "ending", position: { x: 0, y: 0 }, data: { title: "A", description: "" } },
      { id: "ending-b", type: "ending", position: { x: 0, y: 0 }, data: { title: "B", description: "" } },
    );
    duplicateOutput.chapters[0]!.edges.push(
      { id: "edge-a", source: duplicateStart.id, target: "ending-a" },
      { id: "edge-b", source: duplicateStart.id, sourceHandle: "out", target: "ending-b" },
    );
    expect(isStoryDocument(duplicateOutput)).toBe(false);

    const invalidHandle = createStoryDocument();
    const invalidStart = invalidHandle.chapters[0]!.nodes[0]!;
    invalidHandle.chapters[0]!.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: { title: "Choose", options: [{ id: "known", label: "Known" }] },
    });
    invalidHandle.chapters[0]!.edges.push({ id: "edge", source: "choice", sourceHandle: "missing", target: invalidStart.id });
    expect(isStoryDocument(invalidHandle)).toBe(false);

    const emptyId = createStoryDocument();
    emptyId.chapters[0]!.id = "";
    expect(isStoryDocument(emptyId)).toBe(false);

    const duplicateChapter = createStoryDocument();
    duplicateChapter.chapters.push({ ...duplicateChapter.chapters[0]! });
    expect(isStoryDocument(duplicateChapter)).toBe(false);

    const emptyEdgeId = createStoryDocument();
    emptyEdgeId.chapters[0]!.nodes.push({
      id: "ending",
      type: "ending",
      position: { x: 0, y: 0 },
      data: { title: "End", description: "" },
    });
    emptyEdgeId.chapters[0]!.edges.push({ id: "", source: emptyEdgeId.chapters[0]!.nodes[0]!.id, target: "ending" });
    expect(isStoryDocument(emptyEdgeId)).toBe(false);
  });

  it("traverses a playable scene and choice graph", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Arrival", description: "" } },
      {
        id: "choice",
        type: "choice",
        position: { x: 0, y: 0 },
        data: { title: "Where next?", options: [{ id: "left", label: "Go left" }, { id: "right", label: "Go right" }] },
      },
      { id: "ending-a", type: "ending", position: { x: 0, y: 0 }, data: { title: "Left", description: "" } },
      { id: "ending-b", type: "ending", position: { x: 0, y: 0 }, data: { title: "Right", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, sourceHandle: "out", target: "scene" },
      { id: "scene-choice", source: "scene", sourceHandle: "out", target: "choice" },
      { id: "left-ending", source: "choice", sourceHandle: "left", target: "ending-a" },
      { id: "right-ending", source: "choice", sourceHandle: "right", target: "ending-b" },
    );

    expect(validatePlayableChapter(chapter)).toBeUndefined();
    expect(getOutgoingEdge(chapter, "choice", "right")?.id).toBe("right-ending");
    expect(getNextNode(chapter, start.id)?.id).toBe("scene");
    expect(getNextNode(chapter, "choice", "left")?.id).toBe("ending-a");
  });

  it("reports the first missing connection on a reachable path", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: start.id, message: "Connect Start to a next node." });

    chapter.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: { title: "Choose", options: [{ id: "only", label: "Continue" }] },
    });
    chapter.edges.push({ id: "edge", source: start.id, target: "choice" });
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: "choice", message: "Connect the choice \"Continue\"." });
  });

  it("allows loops and ignores disconnected draft nodes", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      { id: "loop", type: "scene", position: { x: 0, y: 0 }, data: { title: "Loop", description: "" } },
      { id: "draft", type: "scene", position: { x: 0, y: 0 }, data: { title: "Draft", description: "" } },
    );
    chapter.edges.push(
      { id: "enter-loop", source: start.id, target: "loop" },
      { id: "repeat-loop", source: "loop", target: "loop" },
    );

    expect(validatePlayableChapter(chapter)).toBeUndefined();
  });

  it("replaces the existing connection from the same output", () => {
    const edges = [
      { id: "first", source: "choice", sourceHandle: "left", target: "scene-a" },
      { id: "second", source: "choice", sourceHandle: "right", target: "scene-b" },
    ];
    expect(replaceOutgoingEdge(edges, { id: "replacement", source: "choice", sourceHandle: "left", target: "scene-c" }))
      .toEqual([
        { id: "second", source: "choice", sourceHandle: "right", target: "scene-b" },
        { id: "replacement", source: "choice", sourceHandle: "left", target: "scene-c" },
      ]);
  });
});
