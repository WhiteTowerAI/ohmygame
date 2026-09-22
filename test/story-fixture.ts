import type { StoryDocument } from "../src/shared/contracts.js";
import { createStoryDocument, DEFAULT_ENDING_SURFACE_FILES, DEFAULT_OPEN_UI_CODE, DEFAULT_OPEN_UI_CONTENT, DEFAULT_STORY_MAP_SURFACE_FILES } from "../src/shared/story.js";

export function createPlayableStoryDocument(): StoryDocument {
  const story = createStoryDocument();
  const startId = crypto.randomUUID();
  const openUiId = crypto.randomUUID();
  const storyMapId = crypto.randomUUID();
  const endingId = crypto.randomUUID();
  story.editorLayout.nodes = {
    [startId]: { x: 80, y: 180 },
    [openUiId]: { x: 240, y: 210 },
    [storyMapId]: { x: 500, y: 440 },
    [endingId]: { x: 760, y: 210 },
  };
  story.chapter.nodes = [
    { id: startId, type: "start", position: { x: 80, y: 180 }, data: {} },
    { id: openUiId, type: "open-ui", position: { x: 240, y: 210 }, data: { title: "Untitled Story", content: structuredClone(DEFAULT_OPEN_UI_CONTENT), presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } } } },
    { id: storyMapId, type: "story-map", position: { x: 500, y: 440 }, data: { title: "Story Map", presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_STORY_MAP_SURFACE_FILES) } } } },
    { id: endingId, type: "ending", position: { x: 760, y: 210 }, data: { title: "Untitled ending", description: "", presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } } },
  ];
  story.chapter.edges = [
    { id: crypto.randomUUID(), source: startId, target: openUiId },
    { id: crypto.randomUUID(), source: openUiId, target: endingId },
    { id: crypto.randomUUID(), source: openUiId, sourceHandle: "story-map", target: storyMapId },
  ];
  return story;
}
