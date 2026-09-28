import { describe, expect, it } from "vitest";
import { createInteractiveDramaStarterStory } from "../src/shared/interactive-drama-starter.js";
import { createStoryDocument } from "../src/shared/story.js";
import { findAssetCanvasCoverSource, findStoryCoverSource } from "../src/shared/story-cover.js";

const TEST_VIDEO_MODEL = { provider: "openrouter", id: "example/video-model" } as const;

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

  it("uses the last generated visual output in an Asset Canvas", () => {
    const story = createStoryDocument();
    story.chapter.nodes = [
      { id: "image", type: "image", position: { x: 0, y: 0 }, data: { prompt: "", resolution: "1K", aspectRatio: "1:1", images: [], assetId: "image-1" } },
      { id: "video", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", model: TEST_VIDEO_MODEL, resolution: "720p", aspectRatio: "adaptive", duration: 6, references: [], assetId: "video-1" } },
      { id: "model", type: "model-3d", position: { x: 0, y: 0 }, data: { targetPolycount: 4_000, texture: true, pbr: false, images: [], assetId: "model-1" } },
    ];

    expect(findAssetCanvasCoverSource(story)).toEqual({ assetId: "video-1", mediaType: "video" });
  });
});
