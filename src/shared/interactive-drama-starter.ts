import type { StoryDocument, StoryInteractionBehavior, StorySurfaceFiles } from "./contracts.js";
import { DEFAULT_CHOICE_SURFACE_FILES, DEFAULT_ENDING_SURFACE_FILES, DEFAULT_OPEN_UI_CODE, DEFAULT_OPEN_UI_CONTENT, DEFAULT_OPEN_UI_SOURCE } from "./story.js";
import { createStoryInteractionFiles } from "./story-interaction-code.js";

export const INTERACTIVE_DRAMA_STARTER = {
  id: "night-train",
  name: "Last Train Home",
} as const;

export function createInteractiveDramaStarterStory(assets: { videoId: string }, title: string = INTERACTIVE_DRAMA_STARTER.name): StoryDocument {
  const id = () => crypto.randomUUID();
  const chapterId = id();
  const startId = id();
  const stateId = id();
  const sceneId = id();
  const choiceId = id();
  const leaveEndingId = id();
  const stayEndingId = id();
  const mediaId = id();
  const hotspotId = id();
  const qteId = id();
  const courageId = id();
  const ticketId = id();
  const leaveOptionId = id();
  const stayOptionId = id();
  const hotspotBehavior: StoryInteractionBehavior = {
    type: "hotspot",
    durationMs: 3_000,
    label: "Inspect the glowing ticket",
    region: { x: 0.4, y: 0.46, width: 0.2, height: 0.2 },
    success: {
      actions: [
        { type: "set-variable", variableId: ticketId, value: true },
        { type: "increment-variable", variableId: courageId, amount: 1 },
      ],
    },
    timeout: { actions: [] },
  };
  const qteBehavior: StoryInteractionBehavior = {
    type: "qte",
    durationMs: 2_500,
    prompt: "Press Space to board",
    key: "Space",
    success: { actions: [{ type: "increment-variable", variableId: courageId, amount: 1 }] },
    timeout: { actions: [{ type: "increment-variable", variableId: courageId, amount: -1 }] },
  };

  return {
    version: 9,
    codebase: { version: 2 },
    editorLayout: {
      version: 1,
      nodes: {
        [startId]: { x: 80, y: 240 },
        "open-ui": { x: 250, y: 210 },
        [stateId]: { x: 760, y: 210 },
        [sceneId]: { x: 1_160, y: 210 },
        [hotspotId]: { x: 1_660, y: 120 },
        [qteId]: { x: 2_000, y: 120 },
        [choiceId]: { x: 2_340, y: 210 },
        [leaveEndingId]: { x: 2_700, y: 100 },
        [stayEndingId]: { x: 2_700, y: 340 },
      },
      viewport: { x: 40, y: 90, zoom: 0.45 },
      view: "canvas",
    },
    player: {
      title,
      viewport: { width: 1280, height: 720 },
      openUiContent: { ...structuredClone(DEFAULT_OPEN_UI_CONTENT), title },
      openUiSource: structuredClone(DEFAULT_OPEN_UI_SOURCE),
      openUiCode: structuredClone(DEFAULT_OPEN_UI_CODE),
      theme: { accentColor: "#62d6cb", textColor: "#ffffff", font: "sans" },
      videoFit: "cover",
      choicePosition: "bottom",
    },
    variables: [
      { id: courageId, name: "Courage", type: "number", initialValue: 2 },
      { id: ticketId, name: "Found ticket", type: "boolean", initialValue: false },
    ],
    chapters: [{
      id: chapterId,
      title: "Platform 13",
      nodes: [
        { id: startId, type: "start", position: { x: 80, y: 240 }, data: {} },
        { id: stateId, type: "project-state", position: { x: 760, y: 210 }, data: {} },
        {
          id: sceneId,
          type: "scene",
          position: { x: 1_160, y: 210 },
          data: {
            title: "The empty platform",
            presentation: {
              media: { mode: "own", items: [{ id: mediaId, type: "video", source: { type: "library", assetId: assets.videoId } }] },
              surface: { files: starterSceneSurfaceFiles(courageId) },
            },
          },
        },
        {
          id: hotspotId,
          type: "interaction",
          position: { x: 1_660, y: 120 },
          data: { title: "Inspect the ticket", behavior: hotspotBehavior, presentation: { media: { mode: "inherit" }, surface: { files: createStoryInteractionFiles(hotspotBehavior) } } },
        },
        {
          id: qteId,
          type: "interaction",
          position: { x: 2_000, y: 120 },
          data: { title: "Board the train", behavior: qteBehavior, presentation: { media: { mode: "inherit" }, surface: { files: createStoryInteractionFiles(qteBehavior) } } },
        },
        {
          id: choiceId,
          type: "choice",
          position: { x: 2_340, y: 210 },
          data: {
            title: "The doors are closing. What will Mara do?",
            options: [
              {
                id: leaveOptionId,
                label: "Take the train",
                condition: { variableId: courageId, operator: "greater-than", value: 2 },
                actions: [{ type: "increment-variable", variableId: courageId, amount: 1 }],
              },
              {
                id: stayOptionId,
                label: "Stay on the platform",
                actions: [{ type: "increment-variable", variableId: courageId, amount: -1 }],
              },
            ],
            timeout: { durationMs: 6_000, defaultOptionId: stayOptionId },
            presentation: { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_CHOICE_SURFACE_FILES) } },
          },
        },
        {
          id: leaveEndingId,
          type: "ending",
          position: { x: 2_700, y: 100 },
          data: { title: "Into the Dawn", description: "Mara steps aboard and chooses the unknown.", presentation: { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } },
        },
        {
          id: stayEndingId,
          type: "ending",
          position: { x: 2_700, y: 340 },
          data: { title: "One More Night", description: "The train leaves. Mara decides to wait for another chance.", presentation: { media: { mode: "inherit" }, surface: { files: structuredClone(DEFAULT_ENDING_SURFACE_FILES) } } },
        },
      ],
      edges: [
        { id: id(), source: startId, target: stateId },
        { id: id(), source: stateId, target: sceneId },
        { id: id(), source: sceneId, target: hotspotId },
        { id: id(), source: hotspotId, sourceHandle: "success", target: qteId },
        { id: id(), source: hotspotId, sourceHandle: "timeout", target: qteId },
        { id: id(), source: qteId, sourceHandle: "success", target: choiceId },
        { id: id(), source: qteId, sourceHandle: "timeout", target: choiceId },
        { id: id(), source: choiceId, sourceHandle: leaveOptionId, target: leaveEndingId },
        { id: id(), source: choiceId, sourceHandle: stayOptionId, target: stayEndingId },
      ],
    }],
  };
}

function starterSceneSurfaceFiles(courageId: string): StorySurfaceFiles {
  return {
    html: '<div id="scene-hud"><strong>Mara</strong><span>Courage <b id="courage">0</b>/5</span><i><em id="courage-fill"></em></i></div>',
    css: `html, body { width: 100%; height: 100%; margin: 0; background: transparent; }
#scene-hud { position: absolute; top: 24px; left: 24px; display: grid; gap: 7px; min-width: 168px; padding: 14px 16px; border: 1px solid rgb(255 255 255 / 28%); border-radius: 6px; background: rgb(8 12 15 / 72%); color: white; font: 500 13px Inter, sans-serif; box-sizing: border-box; }
#scene-hud strong { font-size: 16px; }
#scene-hud span { display: flex; justify-content: space-between; gap: 18px; }
#scene-hud i { display: block; width: 100%; height: 5px; overflow: hidden; background: rgb(255 255 255 / 18%); }
#scene-hud em { display: block; width: 0; height: 100%; background: #62d6cb; transition: width 160ms ease; }`,
    javascript: `const courageId = ${JSON.stringify(courageId)};
function paint({ variables }) {
  const courage = Math.max(0, Math.min(5, Number(variables[courageId]) || 0));
  document.querySelector("#courage").textContent = String(courage);
  document.querySelector("#courage-fill").style.width = String(courage / 5 * 100) + "%";
}
export function render(context) { paint(context); }
export function update(context) { paint(context); }
`,
  };
}
