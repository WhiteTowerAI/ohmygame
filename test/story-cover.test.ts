import { describe, expect, it } from "vitest";
import { createInteractiveDramaStarterStory } from "../src/shared/interactive-drama-starter.js";
import { findStoryCoverSource } from "../src/shared/story-cover.js";

describe("findStoryCoverSource", () => {
  it("finds the first library image on the story entry path", () => {
    const story = createInteractiveDramaStarterStory();
    const scene = story.chapter.nodes.find((node) => node.type === "scene");
    expect(scene?.type).toBe("scene");
    if (!scene || scene.type !== "scene") return;
    scene.data.presentation.media.items = [{ id: "media", type: "image", source: { type: "library", assetId: "image-1" } }];

    expect(findStoryCoverSource(story)).toEqual({ assetId: "image-1", mediaType: "image" });
  });

  it("returns a video source when the first media is a video", () => {
    const story = createInteractiveDramaStarterStory();
    const scene = story.chapter.nodes.find((node) => node.type === "scene");
    expect(scene?.type).toBe("scene");
    if (!scene || scene.type !== "scene") return;
    scene.data.presentation.media.items = [{ id: "media", type: "video", source: { type: "library", assetId: "video-1" } }];

    expect(findStoryCoverSource(story)).toEqual({ assetId: "video-1", mediaType: "video" });
  });
});
