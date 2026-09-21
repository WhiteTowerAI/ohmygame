import { describe, expect, it } from "vitest";
import { createStoryMapContent, createStoryMapLayout } from "../src/renderer/story-map.js";
import { createInteractiveDramaStarterStory } from "../src/shared/interactive-drama-starter.js";

describe("story map", () => {
  it("lays out player-visible nodes and folds internal logic into connections", () => {
    const chapter = createInteractiveDramaStarterStory().chapter;
    const layout = createStoryMapLayout(chapter);
    const choice = chapter.nodes.find((node) => node.type === "choice")!;
    const endings = chapter.nodes.filter((node) => node.type === "ending");

    expect(layout.nodes.map((item) => item.node.type)).toEqual(["scene", "interaction", "interaction", "choice", "ending", "ending"]);
    expect(layout.edges.filter((edge) => edge.source === choice.id).map((edge) => edge.target).sort())
      .toEqual(endings.map((ending) => ending.id).sort());
  });

  it("derives discovered and locked presentation data from runtime progress", () => {
    const chapter = createInteractiveDramaStarterStory().chapter;
    const scene = chapter.nodes.find((node) => node.type === "scene")!;
    const ending = chapter.nodes.find((node) => node.type === "ending")!;
    const content = createStoryMapContent(chapter, {
      visitedNodeIds: [scene.id, ending.id],
      unlockedEndingIds: [ending.id],
      selectedOptionIds: [],
    }, ending.id, { width: 1280, height: 720 }, "#62d6cb", "Paths");

    expect(content).toMatchObject({ screenTitle: "Paths", title: chapter.title });
    expect(content.nodes.find((node) => node.id === scene.id)).toMatchObject({ state: "discovered", current: false });
    expect(content.nodes.find((node) => node.id === ending.id)).toMatchObject({ state: "discovered", current: true });
    expect(content.nodes.some((node) => node.state === "locked" && node.title === "Unknown")).toBe(true);
    expect(content.unlockedEndingCount).toBe(1);
  });
});
