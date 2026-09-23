import type { StoryDocument, StorySurfaceFiles } from "./contracts.js";
import { DEFAULT_CHOICE_SURFACE_FILES, DEFAULT_ENDING_SURFACE_FILES, DEFAULT_OPEN_UI_CODE, DEFAULT_OPEN_UI_CONTENT, DEFAULT_SCENE_DURATION_MS, DEFAULT_SCENE_SURFACE_FILES, DEFAULT_SETTINGS_SURFACE_FILES, DEFAULT_STORY_MAP_SURFACE_FILES } from "./story.js";

export const INTERACTIVE_DRAMA_STARTER = {
  id: "night-train",
  name: "Last Train Home",
} as const;

export function createInteractiveDramaStarterStory(title: string = INTERACTIVE_DRAMA_STARTER.name): StoryDocument {
  const id = () => crypto.randomUUID();
  const chapterId = id();
  const startId = id();
  const openUiId = id();
  const storyMapId = id();
  const settingsId = id();
  const sceneId = id();
  const choiceId = id();
  const leaveStateId = id();
  const stayStateId = id();
  const courageConditionId = id();
  const leaveEndingId = id();
  const stayEndingId = id();
  const hotspotId = id();
  const qteId = id();
  const courageId = id();
  const ticketId = id();
  const leaveOptionId = id();
  const stayOptionId = id();
  const hotspotFiles = starterHotspotSurfaceFiles(ticketId, courageId);
  const qteFiles = starterQteSurfaceFiles(courageId);

  return {
    version: 1,
    editorLayout: {
      version: 1,
      nodes: {
        [startId]: { x: 80, y: 240 },
        [openUiId]: { x: 250, y: 210 },
        [storyMapId]: { x: 500, y: 520 },
        [settingsId]: { x: 500, y: 680 },
        [sceneId]: { x: 760, y: 210 },
        [hotspotId]: { x: 1_260, y: 120 },
        [qteId]: { x: 1_600, y: 120 },
        [choiceId]: { x: 1_940, y: 210 },
        [leaveStateId]: { x: 2_300, y: 120 },
        [stayStateId]: { x: 2_300, y: 360 },
        [courageConditionId]: { x: 2_580, y: 210 },
        [leaveEndingId]: { x: 2_900, y: 100 },
        [stayEndingId]: { x: 2_900, y: 340 },
      },
      viewport: { x: 40, y: 90, zoom: 0.45 },
      view: "canvas",
    },
    player: {
      title,
      viewport: { width: 1280, height: 720 },
      theme: { accentColor: "#62d6cb", textColor: "#ffffff", font: "sans" },
      videoFit: "cover",
      choicePosition: "bottom",
    },
    variables: [
      { id: courageId, name: "Courage", type: "number", initialValue: 2 },
      { id: ticketId, name: "Found ticket", type: "boolean", initialValue: false },
    ],
    chapter: {
      id: chapterId,
      title: "Platform 13",
      nodes: [
        { id: startId, type: "start", position: { x: 80, y: 240 }, data: {} },
        { id: openUiId, type: "open-ui", position: { x: 250, y: 210 }, data: { title, content: { ...structuredClone(DEFAULT_OPEN_UI_CONTENT), title }, presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_OPEN_UI_CODE) } } } },
        { id: storyMapId, type: "story-map", position: { x: 500, y: 520 }, data: { title: "Story Map", presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_STORY_MAP_SURFACE_FILES) } } } },
        { id: settingsId, type: "settings", position: { x: 500, y: 680 }, data: { title: "Settings", presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_SETTINGS_SURFACE_FILES) } } } },
        {
          id: sceneId,
          type: "scene",
          position: { x: 760, y: 210 },
          data: {
            title: "The empty platform",
            durationMs: DEFAULT_SCENE_DURATION_MS,
            presentation: {
              media: { items: [] },
              surface: { files: structuredClone(DEFAULT_SCENE_SURFACE_FILES) },
            },
          },
        },
        {
          id: hotspotId,
          type: "interaction",
          position: { x: 1_260, y: 120 },
          data: { title: "Inspect the ticket", outcomes: ["success", "timeout"], timeout: { durationMs: 3_000, outcome: "timeout" }, presentation: { media: { items: [] }, surface: { files: hotspotFiles } } },
        },
        {
          id: qteId,
          type: "interaction",
          position: { x: 1_600, y: 120 },
          data: { title: "Board the train", outcomes: ["success", "timeout"], timeout: { durationMs: 2_500, outcome: "timeout" }, presentation: { media: { items: [] }, surface: { files: qteFiles } } },
        },
        {
          id: choiceId,
          type: "choice",
          position: { x: 1_940, y: 210 },
          data: {
            title: "The doors are closing. What will Mara do?",
            options: [
              {
                id: leaveOptionId,
                label: "Take the train",
                condition: { variableId: courageId, operator: "greater-than", value: 2 },
              },
              {
                id: stayOptionId,
                label: "Stay on the platform",
              },
            ],
            timeout: { durationMs: 6_000, defaultOptionId: stayOptionId },
            presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_CHOICE_SURFACE_FILES) } },
          },
        },
        {
          id: leaveStateId,
          type: "update-state",
          position: { x: 2_300, y: 120 },
          data: { title: "Build courage", actions: [{ type: "update-variable", variableId: courageId, operator: "add", value: 1 }] },
        },
        {
          id: stayStateId,
          type: "update-state",
          position: { x: 2_300, y: 360 },
          data: { title: "Lose courage", actions: [{ type: "update-variable", variableId: courageId, operator: "subtract", value: 1 }] },
        },
        {
          id: courageConditionId,
          type: "condition",
          position: { x: 2_580, y: 210 },
          data: { title: "Enough courage?", condition: { variableId: courageId, operator: "greater-than-or-equal", value: 4 } },
        },
        {
          id: leaveEndingId,
          type: "ending",
          position: { x: 2_900, y: 100 },
          data: { title: "Into the Dawn", description: "Mara steps aboard and chooses the unknown.", presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } },
        },
        {
          id: stayEndingId,
          type: "ending",
          position: { x: 2_900, y: 340 },
          data: { title: "One More Night", description: "The train leaves. Mara decides to wait for another chance.", presentation: { media: { items: [] }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } },
        },
      ],
      edges: [
        { id: id(), source: startId, target: openUiId },
        { id: id(), source: openUiId, target: sceneId },
        { id: id(), source: openUiId, sourceHandle: "story-map", target: storyMapId },
        { id: id(), source: openUiId, sourceHandle: "settings", target: settingsId },
        { id: id(), source: sceneId, target: hotspotId },
        { id: id(), source: hotspotId, sourceHandle: "success", target: qteId },
        { id: id(), source: hotspotId, sourceHandle: "timeout", target: qteId },
        { id: id(), source: qteId, sourceHandle: "success", target: choiceId },
        { id: id(), source: qteId, sourceHandle: "timeout", target: choiceId },
        { id: id(), source: choiceId, sourceHandle: leaveOptionId, target: leaveStateId },
        { id: id(), source: choiceId, sourceHandle: stayOptionId, target: stayStateId },
        { id: id(), source: leaveStateId, target: courageConditionId },
        { id: id(), source: stayStateId, target: courageConditionId },
        { id: id(), source: courageConditionId, sourceHandle: "true", target: leaveEndingId },
        { id: id(), source: courageConditionId, sourceHandle: "false", target: stayEndingId },
      ],
    },
  };
}

function starterHotspotSurfaceFiles(ticketId: string, courageId: string): StorySurfaceFiles {
  return {
    html: '<button id="hotspot" type="button">Inspect the glowing ticket</button>',
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { position: relative; font-family: Inter, system-ui, sans-serif; }
#hotspot { position: absolute; left: 40%; top: 46%; width: 20%; height: 20%; border: 1px solid rgb(255 255 255 / 78%); border-radius: 4px; background: rgb(17 18 20 / 42%); color: white; font: inherit; cursor: pointer; }`,
    javascript: `export async function run({ ui, game }) {
  await ui.waitForClick("#hotspot");
  game.variables.set(${JSON.stringify(ticketId)}, true);
  game.variables.increment(${JSON.stringify(courageId)}, 1);
  return "success";
}
`,
  };
}

function starterQteSurfaceFiles(courageId: string): StorySurfaceFiles {
  return {
    html: '<div id="qte"><span>Press Space to board</span><button id="action" type="button">Space</button></div>',
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; }
#qte { display: grid; justify-items: center; gap: 14px; color: white; font-weight: 700; text-shadow: 0 2px 10px #000; }
#action { min-width: 62px; min-height: 54px; border: 2px solid #fff; border-radius: 6px; background: rgb(9 10 12 / 84%); color: white; font: 700 16px Inter, system-ui, sans-serif; cursor: pointer; }`,
    javascript: `export async function run({ ui, game }) {
  await Promise.race([
    ui.waitForClick("#action").then(() => "success"),
    ui.waitForKey("Space").then(() => "success"),
  ]);
  game.variables.increment(${JSON.stringify(courageId)}, 1);
  return "success";
}
`,
  };
}
