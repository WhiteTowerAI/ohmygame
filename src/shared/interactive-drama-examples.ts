import type { StoryDocument } from "./contracts.js";

export const INTERACTIVE_DRAMA_EXAMPLE_ID = "night-train" as const;

export const INTERACTIVE_DRAMA_EXAMPLE = {
  name: "Last Train Home",
  description: "A compact story with overlays, a timed choice, a hotspot, and a QTE.",
} as const;

export function createInteractiveDramaExampleStory(assets: { videoId: string; avatarId: string }): StoryDocument {
  const id = () => crypto.randomUUID();
  const chapterId = id();
  const startId = id();
  const sceneId = id();
  const choiceId = id();
  const leaveEndingId = id();
  const stayEndingId = id();
  const clipId = id();
  const hotspotId = id();
  const qteId = id();
  const courageId = id();
  const ticketId = id();
  const characterId = id();
  const characterOverlayId = id();
  const statusOverlayId = id();
  const ticketOverlayId = id();
  const leaveOptionId = id();
  const stayOptionId = id();

  return {
    version: 8,
    player: {
      title: INTERACTIVE_DRAMA_EXAMPLE.name,
      theme: { accentColor: "#62d6cb", textColor: "#ffffff", font: "sans" },
      videoFit: "cover",
      choicePosition: "bottom",
    },
    variables: [
      { id: courageId, name: "Courage", type: "number", initialValue: 2 },
      { id: ticketId, name: "Found ticket", type: "boolean", initialValue: false },
    ],
    characters: [{ id: characterId, name: "Mara", avatarAssetId: assets.avatarId }],
    overlays: [
      {
        id: characterOverlayId,
        name: "Mara",
        placement: "top-left",
        components: [{ id: id(), type: "character", characterId, display: "avatar-name" }],
      },
      {
        id: statusOverlayId,
        name: "Courage",
        placement: "top-right",
        components: [{ id: id(), type: "meter", label: "Courage", variableId: courageId, min: 0, max: 5 }],
      },
      {
        id: ticketOverlayId,
        name: "Ticket found",
        placement: "bottom-left",
        condition: { variableId: ticketId, operator: "equals", value: true },
        components: [{ id: id(), type: "text", text: "You found the last ticket." }],
      },
    ],
    chapters: [{
      id: chapterId,
      title: "Platform 13",
      nodes: [
        { id: startId, type: "start", position: { x: 80, y: 240 }, data: {} },
        {
          id: sceneId,
          type: "scene",
          position: { x: 330, y: 210 },
          data: {
            title: "The empty platform",
            clips: [{ id: clipId, source: { type: "library", assetId: assets.videoId } }],
            events: [
              {
                id: id(),
                clipId,
                timeMs: 0,
                type: "actions",
                actions: [
                  { type: "show-overlay", overlayId: characterOverlayId },
                  { type: "show-overlay", overlayId: statusOverlayId },
                ],
              },
              {
                id: hotspotId,
                clipId,
                timeMs: 2_000,
                type: "hotspot",
                durationMs: 3_000,
                label: "Inspect the glowing ticket",
                region: { x: 0.4, y: 0.46, width: 0.2, height: 0.2 },
                success: {
                  transition: "continue",
                  actions: [
                    { type: "set-variable", variableId: ticketId, value: true },
                    { type: "increment-variable", variableId: courageId, amount: 1 },
                    { type: "show-overlay", overlayId: ticketOverlayId },
                  ],
                },
                timeout: { transition: "continue", actions: [] },
              },
              {
                id: qteId,
                clipId,
                timeMs: 6_500,
                type: "qte",
                durationMs: 2_500,
                prompt: "Press Space to board",
                key: "Space",
                success: {
                  transition: "continue",
                  actions: [{ type: "increment-variable", variableId: courageId, amount: 1 }],
                },
                timeout: {
                  transition: "continue",
                  actions: [{ type: "increment-variable", variableId: courageId, amount: -1 }],
                },
              },
            ],
          },
        },
        {
          id: choiceId,
          type: "choice",
          position: { x: 620, y: 210 },
          data: {
            title: "The doors are closing. What will Mara do?",
            options: [
              { id: leaveOptionId, label: "Take the train" },
              { id: stayOptionId, label: "Stay on the platform" },
            ],
            timeout: { durationMs: 6_000, defaultOptionId: stayOptionId },
          },
        },
        {
          id: leaveEndingId,
          type: "ending",
          position: { x: 920, y: 100 },
          data: { title: "Into the Dawn", description: "Mara steps aboard and chooses the unknown." },
        },
        {
          id: stayEndingId,
          type: "ending",
          position: { x: 920, y: 340 },
          data: { title: "One More Night", description: "The train leaves. Mara decides to wait for another chance." },
        },
      ],
      edges: [
        { id: id(), source: startId, target: sceneId },
        { id: id(), source: sceneId, target: choiceId },
        { id: id(), source: choiceId, sourceHandle: leaveOptionId, target: leaveEndingId },
        { id: id(), source: choiceId, sourceHandle: stayOptionId, target: stayEndingId },
      ],
    }],
  };
}
