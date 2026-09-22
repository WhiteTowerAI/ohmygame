import { describe, expect, it } from "vitest";
import type { StoryChapter, StoryNode } from "../src/shared/contracts.js";
import { completePreviewSceneMedia, createStoryPreviewSession, updateStoryPreviewSession } from "../src/renderer/playtest.js";
import { createInteractiveDramaStarterStory } from "../src/shared/interactive-drama-starter.js";
import { advanceSceneTime, DEFAULT_SCENE_SURFACE_FILES, previewStoryNode, restartGame } from "../src/shared/story.js";

describe("story node preview", () => {
  it("advances Scene media without leaving the edited node", () => {
    const scene: StoryNode = {
      id: "scene",
      type: "scene",
      position: { x: 0, y: 0 },
      data: {
        title: "Scene",
        durationMs: 3_000,
        presentation: {
          media: { items: [
            { id: "first", type: "image", source: { type: "library", assetId: "first-asset" } },
            { id: "second", type: "image", source: { type: "library", assetId: "second-asset" } },
          ] },
          surface: { files: DEFAULT_SCENE_SURFACE_FILES },
        },
      },
    };
    const chapter: StoryChapter = { id: "chapter", title: "Chapter", nodes: [scene], edges: [] };
    const initial = { mode: "playing" as const, chapterId: chapter.id, nodeId: scene.id, variables: {}, progress: { visitedNodeIds: [], selectedOptionIds: [], unlockedEndingIds: [] }, scenePlayback: { mediaId: "first", timeMs: 0 } };
    const second = completePreviewSceneMedia(chapter, initial, "first", 3_000);
    const completed = completePreviewSceneMedia(chapter, second, "second", 3_000);

    expect(second).toMatchObject({ nodeId: scene.id, scenePlayback: { mediaId: "second", timeMs: 0 } });
    expect(completed).toMatchObject({ nodeId: scene.id, scenePlayback: { mediaId: "second", timeMs: 3_000 } });
  });

  it("uses the runtime checkpoint rules for the in-memory Preview session", () => {
    const story = createInteractiveDramaStarterStory();
    const { chapter, variables } = story;
    const scene = chapter.nodes.find((node) => node.type === "scene")!;
    const initial = previewStoryNode(chapter, variables, scene.id);
    const started = { runtime: initial, checkpoint: initial };
    const progressed = advanceSceneTime(chapter, initial, initial.scenePlayback!.mediaId, 1_100);
    const active = updateStoryPreviewSession(started, progressed);
    const menu = updateStoryPreviewSession(active, restartGame(chapter, variables), "preserve");
    const continued = updateStoryPreviewSession(menu, menu.checkpoint!, "preserve");
    const restarted = updateStoryPreviewSession(active, restartGame(chapter, variables), "clear");

    expect(active.checkpoint?.scenePlayback?.timeMs).toBe(1_100);
    expect(menu.checkpoint).toBe(active.checkpoint);
    expect(continued.runtime).toBe(active.checkpoint);
    expect(restarted.checkpoint).toBeUndefined();
  });

  it("keeps the initial runtime stable when only Open UI layout changes", () => {
    const story = createInteractiveDramaStarterStory();
    const openUi = story.chapter.nodes.find((node) => node.type === "open-ui")!;
    const before = createStoryPreviewSession(story.chapter, story.variables, openUi.id);

    openUi.data.presentation.surface.layout = { title: { offsetX: 40, offsetY: 20 } };
    const after = createStoryPreviewSession(story.chapter, story.variables, openUi.id);

    expect(after).toEqual(before);
  });
});
