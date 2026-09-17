import type { StoryDocument } from "../src/shared/contracts.js";
import { createStoryDocument, DEFAULT_ENDING_SURFACE_FILES, DEFAULT_OPEN_UI_CODE, DEFAULT_OPEN_UI_CONTENT } from "../src/shared/story.js";

export function createPlayableStoryDocument(): StoryDocument {
  const story = createStoryDocument();
  const startId = crypto.randomUUID();
  const openUiId = crypto.randomUUID();
  const stateId = crypto.randomUUID();
  const endingId = crypto.randomUUID();
  story.editorLayout.nodes = {
    [startId]: { x: 80, y: 180 },
    [openUiId]: { x: 240, y: 210 },
    [stateId]: { x: 760, y: 210 },
    [endingId]: { x: 1_120, y: 210 },
  };
  story.chapters[0]!.nodes = [
    { id: startId, type: "start", position: { x: 80, y: 180 }, data: {} },
    { id: openUiId, type: "open-ui", position: { x: 240, y: 210 }, data: { title: "Untitled Story", content: structuredClone(DEFAULT_OPEN_UI_CONTENT), presentation: { media: { mode: "own", items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } } } },
    { id: stateId, type: "project-state", position: { x: 760, y: 210 }, data: { title: "Initial State", actions: [] } },
    { id: endingId, type: "ending", position: { x: 1_120, y: 210 }, data: { title: "Untitled ending", description: "", presentation: { media: { mode: "none" }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } } },
  ];
  story.chapters[0]!.edges = [
    { id: crypto.randomUUID(), source: startId, target: openUiId },
    { id: crypto.randomUUID(), source: openUiId, target: stateId },
    { id: crypto.randomUUID(), source: stateId, target: endingId },
  ];
  return story;
}
