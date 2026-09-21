import { describe, expect, it } from "vitest";
import { createStoryMapLayout } from "../src/renderer/story-map.js";
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
});
