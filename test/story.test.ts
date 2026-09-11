import { describe, expect, it } from "vitest";
import {
  advanceSceneTime,
  createStoryDocument,
  combineStoryPrompt,
  chooseOption,
  completeSceneClip,
  continueSceneEvent,
  createPlayerState,
  createStoryCheckpoint,
  applyStoryActions,
  applyRuntimeActions,
  countSceneVariableReferences,
  countStoryVariableReferences,
  getNextNode,
  getOutgoingEdge,
  getStartNode,
  isStoryDocument,
  initialStoryVariables,
  matchesStoryCondition,
  normalizeOverlayVariableReferences,
  normalizeSceneVariableReferences,
  normalizeStoryVariableReferences,
  parseStoryDocument,
  removeSceneVariableReferences,
  removeStoryVariableReferences,
  replaceOutgoingEdge,
  resolveSceneInteraction,
  restoreStoryCheckpoint,
  resolveStoryAssetId,
  resolveStoryImageAssetId,
  resolveStoryVideoClipAssetId,
  resolveStoryChoice,
  restartGame,
  shouldCreateStoryCheckpoint,
  startGame,
  validatePlayableChapter,
} from "../src/shared/story.js";
import { VIDEO_MODEL } from "../src/shared/contracts.js";

describe("story documents", () => {
  it("combines linked text with a local media prompt", () => {
    expect(combineStoryPrompt("A woman at a train station", "Cinematic wide shot")).toBe("A woman at a train station\n\nCinematic wide shot");
    expect(combineStoryPrompt("", "Cinematic wide shot")).toBe("Cinematic wide shot");
    expect(combineStoryPrompt("A woman at a train station", "")).toBe("A woman at a train station");
  });

  it("creates one chapter with one start node", () => {
    const story = createStoryDocument();
    expect(isStoryDocument(story)).toBe(true);
    expect(isStoryDocument({ ...story, version: 2 })).toBe(false);
    expect(story.chapters).toHaveLength(1);
    expect(story.chapters[0]?.nodes).toEqual([expect.objectContaining({ type: "start" })]);
  });

  it("accepts an optional Player configuration and rejects invalid values", () => {
    const story = createStoryDocument();
    story.player = {
      title: "Night Train",
      backgroundAssetId: "menu-image",
      theme: { accentColor: "#e8bd68", textColor: "#ffffff", font: "serif" },
      videoFit: "cover",
      choicePosition: "bottom",
    };
    expect(isStoryDocument(story)).toBe(true);
    story.player.theme.accentColor = "gold";
    expect(isStoryDocument(story)).toBe(false);
  });

  it("runs menu, scene, choice, and restart through the shared Player runtime", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 1 }];
    story.overlays = [{ id: "hud", name: "HUD", placement: "top-left", components: [] }];
    const chapter = story.chapters[0]!;
    const start = chapter.nodes[0]!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Opening", clips: [{ id: "clip", source: { type: "library", assetId: "video" } }], events: [] } },
      { id: "choice", type: "choice", position: { x: 0, y: 0 }, data: { title: "Choose", options: [{ id: "go", label: "Go", actions: [{ type: "increment-variable", variableId: "score", amount: 2 }, { type: "show-overlay", overlayId: "hud" }] }] } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, target: "scene" },
      { id: "scene-choice", source: "scene", target: "choice" },
      { id: "choice-ending", source: "choice", sourceHandle: "go", target: "ending" },
    );

    const menu = createPlayerState(chapter.id, story.variables);
    expect(menu).toEqual({ mode: "menu", chapterId: chapter.id, variables: { score: 1 }, visibleOverlayIds: [] });
    expect(() => chooseOption(chapter, menu, "go")).toThrow("The game is not playing");
    const scene = startGame(chapter, menu);
    expect(scene.nodeId).toBe("scene");
    expect(() => startGame(chapter, scene)).toThrow("The game has already started");
    const choice = completeSceneClip(chapter, scene, "clip", 1_000);
    expect(choice.nodeId).toBe("choice");
    expect(chooseOption(chapter, choice, "go")).toMatchObject({ nodeId: "ending", variables: { score: 3 }, visibleOverlayIds: ["hud"] });
    expect(restartGame(chapter, story.variables)).toMatchObject({ mode: "playing", nodeId: "scene", variables: { score: 1 }, visibleOverlayIds: [] });
  });

  it("creates and restores validated story checkpoints", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 0 }];
    story.overlays = [{ id: "hud", name: "HUD", placement: "top-left", components: [] }];
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Scene", clips: [{ id: "clip", source: { type: "library", assetId: "video" } }], events: [
        { id: "update", clipId: "clip", timeMs: 250, type: "actions", actions: [{ type: "set-variable", variableId: "score", value: 2 }] },
        { id: "wait", clipId: "clip", timeMs: 500, type: "continue", label: "Continue" },
      ] } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: chapter.nodes[0]!.id, target: "scene" },
      { id: "scene-ending", source: "scene", target: "ending" },
    );
    const playing = advanceSceneTime(chapter, restartGame(chapter, story.variables), "clip", 500);
    const saved = createStoryCheckpoint("signature", { ...playing, variables: { score: 2 }, visibleOverlayIds: ["hud"] }, "2026-09-11T08:00:00.000Z");

    expect(restoreStoryCheckpoint(saved, "signature", chapter, story.variables, story.overlays)).toEqual(saved.checkpoint);
    expect(restoreStoryCheckpoint(saved, "changed", chapter, story.variables, story.overlays)).toBeUndefined();
    expect(restoreStoryCheckpoint({ ...saved, checkpoint: { ...saved.checkpoint, variables: { score: "wrong" } } }, "signature", chapter, story.variables, story.overlays)).toBeUndefined();
    expect(restoreStoryCheckpoint({ ...saved, checkpoint: { ...saved.checkpoint, scenePlayback: { ...saved.checkpoint.scenePlayback!, waitingEventId: "missing" } } }, "signature", chapter, story.variables, story.overlays)).toBeUndefined();
    expect(restoreStoryCheckpoint({ ...saved, checkpoint: { ...saved.checkpoint, scenePlayback: { ...saved.checkpoint.scenePlayback!, firedEventIds: [] } } }, "signature", chapter, story.variables, story.overlays)).toBeUndefined();
    expect(restoreStoryCheckpoint({ ...saved, checkpoint: { ...saved.checkpoint, scenePlayback: { ...saved.checkpoint.scenePlayback!, firedEventIds: ["wait"], waitingEventId: undefined } } }, "signature", chapter, story.variables, story.overlays)).toBeUndefined();
    expect(() => createStoryCheckpoint("signature", createPlayerState(chapter.id, story.variables ?? []))).toThrow("playing state");
  });

  it("creates checkpoints for semantic changes but not playback time alone", () => {
    const initial = { mode: "playing" as const, chapterId: "chapter", nodeId: "scene", variables: { score: 0 }, visibleOverlayIds: [], scenePlayback: { clipId: "clip", timeMs: 0, firedEventIds: [] } };
    expect(shouldCreateStoryCheckpoint(undefined, initial)).toBe(true);
    expect(shouldCreateStoryCheckpoint(initial, { ...initial, scenePlayback: { ...initial.scenePlayback, timeMs: 400 } })).toBe(false);
    expect(shouldCreateStoryCheckpoint(initial, { ...initial, scenePlayback: { ...initial.scenePlayback, timeMs: 400, firedEventIds: ["event"] } })).toBe(true);
    expect(shouldCreateStoryCheckpoint(initial, { ...initial, variables: { score: 1 } })).toBe(true);
    expect(shouldCreateStoryCheckpoint(initial, { ...initial, nodeId: "choice", scenePlayback: undefined })).toBe(true);
    expect(shouldCreateStoryCheckpoint(initial, createPlayerState("chapter", []))).toBe(false);
  });

  it("runs Scene events once, in order, and blocks on Continue", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 0 }];
    const chapter = story.chapters[0]!;
    const start = chapter.nodes[0]!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: {
        title: "Opening",
        clips: [{ id: "clip", source: { type: "library", assetId: "video" } }],
        events: [
          { id: "at-start", clipId: "clip", timeMs: 0, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 1 }] },
          { id: "before-wait", clipId: "clip", timeMs: 1_000, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 2 }] },
          { id: "wait", clipId: "clip", timeMs: 1_000, type: "continue", label: "Go on" },
          { id: "after-wait", clipId: "clip", timeMs: 1_000, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 4 }] },
          { id: "near-end", clipId: "clip", timeMs: 1_500, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 8 }] },
        ],
      } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, target: "scene" },
      { id: "scene-ending", source: "scene", target: "ending" },
    );

    const entered = startGame(chapter, createPlayerState(chapter.id, story.variables));
    expect(entered).toMatchObject({ variables: { score: 1 }, scenePlayback: { clipId: "clip", timeMs: 0, firedEventIds: ["at-start"] } });
    const waiting = advanceSceneTime(chapter, entered, "clip", 1_200);
    expect(waiting).toMatchObject({ variables: { score: 3 }, scenePlayback: { timeMs: 1_000, firedEventIds: ["at-start", "before-wait"], waitingEventId: "wait" } });
    expect(advanceSceneTime(chapter, waiting, "clip", 1_500)).toBe(waiting);
    const resumed = continueSceneEvent(chapter, waiting);
    const advanced = advanceSceneTime(chapter, resumed, "clip", 1_200);
    expect(advanced).toMatchObject({ variables: { score: 7 }, scenePlayback: { timeMs: 1_200, firedEventIds: ["at-start", "before-wait", "wait", "after-wait"] } });
    expect(advanceSceneTime(chapter, advanced, "clip", 500)).toBe(advanced);
    expect(completeSceneClip(chapter, advanced, "clip", 2_000)).toMatchObject({ nodeId: "ending", variables: { score: 15 }, scenePlayback: undefined });
  });

  it("resolves consecutive end-of-clip Continues before advancing clips", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 0 }];
    const chapter = story.chapters[0]!;
    const start = chapter.nodes[0]!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: {
        title: "Opening",
        clips: [
          { id: "first", source: { type: "library", assetId: "first-video" } },
          { id: "second", source: { type: "library", assetId: "second-video" } },
        ],
        events: [
          { id: "first-wait", clipId: "first", timeMs: 1_000, type: "continue", label: "First" },
          { id: "second-wait", clipId: "first", timeMs: 1_000, type: "continue", label: "Second" },
          { id: "second-start", clipId: "second", timeMs: 0, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 1 }] },
        ],
      } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, target: "scene" },
      { id: "scene-ending", source: "scene", target: "ending" },
    );

    const menu = createPlayerState(chapter.id, story.variables);
    expect(() => completeSceneClip(chapter, menu, "first", 1_000)).toThrow("The game is not playing");
    const entered = startGame(chapter, menu);
    expect(() => continueSceneEvent(chapter, entered)).toThrow("The scene is not waiting for Continue");
    const firstWait = completeSceneClip(chapter, entered, "first", 1_000);
    expect(firstWait.scenePlayback?.waitingEventId).toBe("first-wait");
    const secondWait = continueSceneEvent(chapter, firstWait);
    expect(secondWait.scenePlayback?.waitingEventId).toBe("second-wait");
    const ready = continueSceneEvent(chapter, secondWait);
    expect(ready.scenePlayback?.waitingEventId).toBeUndefined();
    const secondClip = completeSceneClip(chapter, ready, "first", 1_000);
    expect(secondClip).toMatchObject({ nodeId: "scene", variables: { score: 1 }, scenePlayback: { clipId: "second", firedEventIds: ["second-start"] } });
    expect(completeSceneClip(chapter, secondClip, "second", 2_000)).toMatchObject({ nodeId: "ending", scenePlayback: undefined });
  });

  it("evaluates story variables and applies actions in order", () => {
    const definitions = [
      { id: "trusted", name: "Trusted", type: "boolean" as const, initialValue: false },
      { id: "score", name: "Score", type: "number" as const, initialValue: 2 },
    ];
    const initial = initialStoryVariables(definitions);

    expect(matchesStoryCondition({ variableId: "trusted", operator: "equals", value: false }, initial)).toBe(true);
    expect(matchesStoryCondition({ variableId: "score", operator: "greater-than", value: 1 }, initial)).toBe(true);
    expect(matchesStoryCondition({ variableId: "score", operator: "less-than", value: 1 }, initial)).toBe(false);
    expect(applyStoryActions([
      { type: "set-variable", variableId: "trusted", value: true },
      { type: "set-variable", variableId: "score", value: 4 },
      { type: "increment-variable", variableId: "score", amount: 3 },
    ], initial)).toEqual({ trusted: true, score: 7 });
    expect(initial).toEqual({ trusted: false, score: 2 });
    expect(() => applyStoryActions([{ type: "increment-variable", variableId: "trusted", amount: 1 }], initial))
      .toThrow("Cannot increment non-number variable");
    expect(initial).toEqual({ trusted: false, score: 2 });
  });

  it("validates overlays and applies their actions idempotently", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "health", name: "Health", type: "number", initialValue: 80 }];
    story.overlays = [{
      id: "hud",
      name: "HUD",
      placement: "top-left",
      condition: { variableId: "health", operator: "greater-than", value: 0 },
      components: [
        { id: "title", type: "text", text: "Status" },
        { id: "portrait", type: "image", assetId: "portrait-image", alt: "Portrait" },
        { id: "health-value", type: "value", label: "Health", variableId: "health" },
        { id: "health-meter", type: "meter", label: "Health", variableId: "health", min: 0, max: 100 },
      ],
    }];
    story.chapters[0]!.nodes.push({ id: "choice", type: "choice", position: { x: 0, y: 0 }, data: { title: "Choice", options: [{ id: "show", label: "Show", actions: [{ type: "show-overlay", overlayId: "hud" }] }] } });
    expect(isStoryDocument(story)).toBe(true);
    expect(applyRuntimeActions({ variables: { health: 80 }, visibleOverlayIds: [] }, [
      { type: "show-overlay", overlayId: "hud" },
      { type: "show-overlay", overlayId: "hud" },
      { type: "increment-variable", variableId: "health", amount: -10 },
    ])).toEqual({ variables: { health: 70 }, visibleOverlayIds: ["hud"] });
    expect(applyRuntimeActions({ variables: { health: 80 }, visibleOverlayIds: ["hud"] }, [
      { type: "hide-overlay", overlayId: "missing" },
      { type: "hide-overlay", overlayId: "hud" },
    ])).toEqual({ variables: { health: 80 }, visibleOverlayIds: [] });
    const choice = story.chapters[0]!.nodes.find((node) => node.id === "choice");
    if (choice?.type !== "choice") throw new Error("Choice missing");
    choice.data.options[0]!.actions = [{ type: "show-overlay", overlayId: "missing" }];
    expect(isStoryDocument(story)).toBe(false);
    choice.data.options[0]!.actions = [{ type: "show-overlay", overlayId: "hud" }];
    story.overlays[0]!.components[3] = { id: "health-meter", type: "meter", label: "Health", variableId: "health", min: 100, max: 0 };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("normalizes Overlay references when Variables change", () => {
    const overlays = [{
      id: "hud",
      name: "HUD",
      placement: "top-left" as const,
      condition: { variableId: "health", operator: "greater-than" as const, value: 10 },
      components: [
        { id: "value", type: "value" as const, label: "Name", variableId: "name" },
        { id: "meter", type: "meter" as const, label: "Health", variableId: "health", min: 0, max: 100 },
      ],
    }];
    const variables = new Map([
      ["health", { id: "health", name: "Health", type: "text" as const, initialValue: "full" }],
      ["name", { id: "name", name: "Name", type: "text" as const, initialValue: "Ari" }],
    ]);
    expect(normalizeOverlayVariableReferences(overlays, variables)).toEqual([{
      ...overlays[0],
      condition: { variableId: "health", operator: "equals", value: "" },
      components: [overlays[0]!.components[0]],
    }]);
  });

  it("migrates version 5 documents with an empty overlay list", () => {
    const current = createStoryDocument();
    const legacy = { ...current, version: 5 };
    delete (legacy as { overlays?: unknown }).overlays;
    expect(parseStoryDocument(legacy).overlays).toEqual([]);
  });

  it("migrates version 6 documents to version 7", () => {
    const legacy = { ...createStoryDocument(), version: 6 };
    expect(parseStoryDocument(legacy).version).toBe(7);
  });

  it("migrates version 3 choice effects into the current document", () => {
    const migrated = parseStoryDocument({
      version: 3,
      variables: [{ id: "trusted", name: "Trusted", type: "boolean", initialValue: false }],
      chapters: [{
        id: "chapter",
        title: "Chapter",
        nodes: [
          { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
          { id: "choice", type: "choice", position: { x: 100, y: 0 }, data: { title: "Trust?", options: [{ id: "yes", label: "Yes", effect: { variableId: "trusted", value: true } }] } },
          { id: "ending", type: "ending", position: { x: 200, y: 0 }, data: { title: "End", description: "" } },
        ],
        edges: [
          { id: "start-choice", source: "start", target: "choice" },
          { id: "choice-ending", source: "choice", sourceHandle: "yes", target: "ending" },
        ],
      }],
    });

    expect(migrated.version).toBe(7);
    const choice = migrated.chapters[0]!.nodes.find((node) => node.type === "choice");
    expect(choice?.type === "choice" ? choice.data.options[0]?.actions : undefined).toEqual([
      { type: "set-variable", variableId: "trusted", value: true },
    ]);
  });

  it("adds empty Scene events when migrating version 4", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({ id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Scene", clips: [], events: [] } });
    const legacy = structuredClone(story) as unknown as { version: number; chapters: Array<{ nodes: Array<{ type: string; data: Record<string, unknown> }> }> };
    legacy.version = 4;
    delete legacy.chapters[0]!.nodes[1]!.data.events;

    const migrated = parseStoryDocument(legacy);
    const scene = migrated.chapters[0]!.nodes.find((node) => node.type === "scene");
    expect(migrated.version).toBe(7);
    expect(scene?.type === "scene" ? scene.data.events : undefined).toEqual([]);
  });

  it("validates Scene event structure and known clip duration", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 0 }];
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: {
        title: "Scene",
        clips: [{ id: "clip", source: { type: "library", assetId: "video" } }],
        events: [{ id: "event", clipId: "clip", timeMs: 2_001, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 1 }] }],
      } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: chapter.nodes[0]!.id, target: "scene" },
      { id: "scene-ending", source: "scene", target: "ending" },
    );

    expect(isStoryDocument(story)).toBe(true);
    expect(validatePlayableChapter(chapter, { assetDurationsMs: new Map([["video", 2_000]]) })).toEqual({
      nodeId: "scene",
      message: "An event in \"Scene\" is after its video clip ends.",
    });
    const scene = chapter.nodes.find((node) => node.type === "scene");
    if (scene?.type !== "scene") throw new Error("Scene missing");
    scene.data.events[0] = { ...scene.data.events[0]!, clipId: "missing" };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("resolves Scene interactions through shared outcomes", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 0 }];
    story.overlays = [{ id: "hud", name: "HUD", placement: "top-left", components: [] }];
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: {
        title: "Scene",
        clips: [{ id: "clip", source: { type: "library", assetId: "video" } }],
        events: [
          { id: "hotspot", clipId: "clip", timeMs: 500, type: "hotspot", durationMs: 3_000, label: "Door", region: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 }, success: { transition: "continue", actions: [{ type: "increment-variable", variableId: "score", amount: 2 }, { type: "show-overlay", overlayId: "hud" }] }, timeout: { transition: "branch", actions: [] } },
          { id: "after", clipId: "clip", timeMs: 500, type: "actions", actions: [{ type: "increment-variable", variableId: "score", amount: 4 }] },
          { id: "qte", clipId: "clip", timeMs: 1_000, type: "qte", durationMs: 2_000, prompt: "Dodge", key: "Space", success: { transition: "continue", actions: [] }, timeout: { transition: "branch", actions: [{ type: "increment-variable", variableId: "score", amount: 8 }] } },
        ],
      } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "Missed", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: chapter.nodes[0]!.id, target: "scene" },
      { id: "scene-end", source: "scene", target: "ending" },
      { id: "hotspot-timeout", source: "scene", sourceHandle: "interaction:hotspot:timeout", target: "ending" },
      { id: "qte-timeout", source: "scene", sourceHandle: "interaction:qte:timeout", target: "ending" },
    );

    expect(isStoryDocument(story)).toBe(true);
    expect(validatePlayableChapter(chapter)).toBeUndefined();
    const entered = startGame(chapter, createPlayerState(chapter.id, story.variables));
    const waitingHotspot = advanceSceneTime(chapter, entered, "clip", 800);
    expect(waitingHotspot.scenePlayback?.waitingEventId).toBe("hotspot");
    expect(() => continueSceneEvent(chapter, waitingHotspot)).toThrow("not waiting for Continue");
    expect(() => resolveSceneInteraction(chapter, waitingHotspot, "qte", "success")).toThrow("not active");
    const continued = resolveSceneInteraction(chapter, waitingHotspot, "hotspot", "success");
    expect(continued).toMatchObject({ variables: { score: 6 }, visibleOverlayIds: ["hud"], scenePlayback: { waitingEventId: undefined } });
    const waitingQte = advanceSceneTime(chapter, continued, "clip", 1_200);
    expect(waitingQte.scenePlayback?.waitingEventId).toBe("qte");
    expect(resolveSceneInteraction(chapter, waitingQte, "qte", "timeout")).toMatchObject({ nodeId: "ending", variables: { score: 14 }, scenePlayback: undefined });
  });

  it("validates Scene interaction fields and branch connections", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push({ id: "scene", type: "scene", position: { x: 0, y: 0 }, data: {
      title: "Scene",
      clips: [{ id: "clip", source: { type: "library", assetId: "video" } }],
      events: [{ id: "qte", clipId: "clip", timeMs: 0, type: "qte", durationMs: 3_000, prompt: "Dodge", key: "KeyE", success: { transition: "continue", actions: [] }, timeout: { transition: "branch", actions: [] } }],
    } });
    chapter.nodes.push({ id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } });
    chapter.edges.push(
      { id: "start-scene", source: chapter.nodes[0]!.id, target: "scene" },
      { id: "scene-end", source: "scene", target: "ending" },
    );
    expect(isStoryDocument(story)).toBe(true);
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: "scene", message: "Connect the timeout outcome in \"Scene\"." });
    const scene = chapter.nodes[1];
    if (scene?.type !== "scene") throw new Error("Scene missing");
    const qte = scene.data.events[0];
    if (qte?.type !== "qte") throw new Error("QTE missing");
    scene.data.events[0] = { ...qte, key: "Escape" };
    expect(isStoryDocument(story)).toBe(false);
    scene.data.events[0] = { ...qte, durationMs: 100 };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("cleans and normalizes variable actions in Scene outcomes", () => {
    const events = [{
      id: "qte",
      clipId: "clip",
      timeMs: 0,
      type: "qte" as const,
      durationMs: 3_000,
      prompt: "Dodge",
      key: "KeyE",
      success: { transition: "continue" as const, actions: [{ type: "set-variable" as const, variableId: "score", value: 4 }] },
      timeout: { transition: "continue" as const, actions: [{ type: "increment-variable" as const, variableId: "score", amount: 1 }] },
    }];
    expect(countSceneVariableReferences(events, "score")).toBe(2);
    expect(removeSceneVariableReferences(events, "score")[0]).toMatchObject({ success: { actions: [] }, timeout: { actions: [] } });
    expect(normalizeSceneVariableReferences(events, new Map([
      ["score", { id: "score", name: "Score", type: "text" as const, initialValue: "" }],
    ]))[0]).toMatchObject({ success: { actions: [{ value: "" }] }, timeout: { actions: [] } });
  });

  it("resolves a choice through shared actions and its edge", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "score", name: "Score", type: "number", initialValue: 1 }];
    const chapter = story.chapters[0]!;
    const start = chapter.nodes[0]!;
    chapter.nodes.push(
      { id: "choice", type: "choice", position: { x: 0, y: 0 }, data: { title: "Choose", options: [{ id: "go", label: "Go", actions: [{ type: "increment-variable", variableId: "score", amount: 2 }] }] } },
      { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-choice", source: start.id, target: "choice" },
      { id: "choice-ending", source: "choice", sourceHandle: "go", target: "ending" },
    );

    expect(resolveStoryChoice(chapter, { chapterId: chapter.id, nodeId: "choice", variables: { score: 1 }, visibleOverlayIds: [] }, "go"))
      .toEqual({ chapterId: chapter.id, nodeId: "ending", variables: { score: 3 }, visibleOverlayIds: [] });
  });

  it("validates timed choice bounds and default options", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push({ id: "choice", type: "choice", position: { x: 0, y: 0 }, data: {
      title: "Choose",
      options: [{ id: "wait", label: "Wait" }],
      timeout: { durationMs: 8_000, defaultOptionId: "wait" },
    } });
    expect(isStoryDocument(story)).toBe(true);
    const choice = chapter.nodes.at(-1);
    if (choice?.type === "choice") choice.data.timeout = { durationMs: 999, defaultOptionId: "wait" };
    expect(isStoryDocument(story)).toBe(false);
    if (choice?.type === "choice") choice.data.timeout = { durationMs: 8_000, defaultOptionId: "missing" };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("validates variable-backed choice rules", () => {
    const story = createStoryDocument();
    story.variables = [{ id: "trusted", name: "Trusted", type: "boolean", initialValue: false }];
    story.chapters[0]!.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: {
        title: "Enter?",
        options: [{
          id: "enter",
          label: "Enter",
          condition: { variableId: "trusted", operator: "equals", value: true },
          actions: [{ type: "set-variable", variableId: "trusted", value: false }],
        }],
      },
    });

    expect(isStoryDocument(story)).toBe(true);
    story.variables = [];
    expect(isStoryDocument(story)).toBe(false);
  });

  it("cleans and normalizes variable-backed choice rules", () => {
    const options = [{
      id: "enter",
      label: "Enter",
      condition: { variableId: "state", operator: "greater-than" as const, value: 3 },
      actions: [{ type: "set-variable" as const, variableId: "state", value: 4 }],
    }];

    expect(countStoryVariableReferences(options, "state")).toBe(2);
    expect(removeStoryVariableReferences(options, "state")).toEqual([{ id: "enter", label: "Enter", condition: undefined, actions: undefined }]);
    expect(normalizeStoryVariableReferences(options, new Map([
      ["state", { id: "state", name: "State", type: "text" as const, initialValue: "" }],
    ]))).toEqual([{
      id: "enter",
      label: "Enter",
      condition: { variableId: "state", operator: "equals", value: "" },
      actions: [{ type: "set-variable", variableId: "state", value: "" }],
    }]);
    expect(normalizeStoryVariableReferences(options, new Map())).toEqual([{ id: "enter", label: "Enter", condition: undefined, actions: undefined }]);
  });

  it("rejects missing starts, duplicate ids, and dangling edges", () => {
    const missingStart = createStoryDocument();
    missingStart.chapters[0]!.nodes = [];
    expect(isStoryDocument(missingStart)).toBe(false);

    const duplicate = createStoryDocument();
    duplicate.chapters[0]!.nodes.push({ ...duplicate.chapters[0]!.nodes[0]! });
    expect(isStoryDocument(duplicate)).toBe(false);

    const dangling = createStoryDocument();
    dangling.chapters[0]!.edges.push({ id: "edge", source: dangling.chapters[0]!.nodes[0]!.id, target: "missing" });
    expect(isStoryDocument(dangling)).toBe(false);

    const duplicateOutput = createStoryDocument();
    const duplicateStart = duplicateOutput.chapters[0]!.nodes[0]!;
    duplicateOutput.chapters[0]!.nodes.push(
      { id: "ending-a", type: "ending", position: { x: 0, y: 0 }, data: { title: "A", description: "" } },
      { id: "ending-b", type: "ending", position: { x: 0, y: 0 }, data: { title: "B", description: "" } },
    );
    duplicateOutput.chapters[0]!.edges.push(
      { id: "edge-a", source: duplicateStart.id, target: "ending-a" },
      { id: "edge-b", source: duplicateStart.id, sourceHandle: "out", target: "ending-b" },
    );
    expect(isStoryDocument(duplicateOutput)).toBe(false);

    const invalidHandle = createStoryDocument();
    const invalidStart = invalidHandle.chapters[0]!.nodes[0]!;
    invalidHandle.chapters[0]!.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: { title: "Choose", options: [{ id: "known", label: "Known" }] },
    });
    invalidHandle.chapters[0]!.edges.push({ id: "edge", source: "choice", sourceHandle: "missing", target: invalidStart.id });
    expect(isStoryDocument(invalidHandle)).toBe(false);

    const emptyId = createStoryDocument();
    emptyId.chapters[0]!.id = "";
    expect(isStoryDocument(emptyId)).toBe(false);

    const duplicateChapter = createStoryDocument();
    duplicateChapter.chapters.push({ ...duplicateChapter.chapters[0]! });
    expect(isStoryDocument(duplicateChapter)).toBe(false);

    const emptyEdgeId = createStoryDocument();
    emptyEdgeId.chapters[0]!.nodes.push({
      id: "ending",
      type: "ending",
      position: { x: 0, y: 0 },
      data: { title: "End", description: "" },
    });
    emptyEdgeId.chapters[0]!.edges.push({ id: "", source: emptyEdgeId.chapters[0]!.nodes[0]!.id, target: "ending" });
    expect(isStoryDocument(emptyEdgeId)).toBe(false);

    const duplicateClip = createStoryDocument();
    duplicateClip.chapters[0]!.nodes.push({
      id: "scene",
      type: "scene",
      position: { x: 0, y: 0 },
      data: {
        title: "Scene",
        clips: [
          { id: "clip", source: { type: "library", assetId: "asset-a" } },
          { id: "clip", source: { type: "library", assetId: "asset-b" } },
        ],
        events: [],
      },
    });
    expect(isStoryDocument(duplicateClip)).toBe(false);
  });

  it("traverses a playable scene and choice graph", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Arrival", clips: [{ id: "arrival", source: { type: "library", assetId: "arrival-video" } }], events: [] } },
      {
        id: "choice",
        type: "choice",
        position: { x: 0, y: 0 },
        data: { title: "Where next?", options: [{ id: "left", label: "Go left" }, { id: "right", label: "Go right" }] },
      },
      { id: "ending-a", type: "ending", position: { x: 0, y: 0 }, data: { title: "Left", description: "" } },
      { id: "ending-b", type: "ending", position: { x: 0, y: 0 }, data: { title: "Right", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, sourceHandle: "out", target: "scene" },
      { id: "scene-choice", source: "scene", sourceHandle: "out", target: "choice" },
      { id: "left-ending", source: "choice", sourceHandle: "left", target: "ending-a" },
      { id: "right-ending", source: "choice", sourceHandle: "right", target: "ending-b" },
    );

    expect(validatePlayableChapter(chapter)).toBeUndefined();
    expect(getOutgoingEdge(chapter, "choice", "right")?.id).toBe("right-ending");
    expect(getNextNode(chapter, start.id)?.id).toBe("scene");
    expect(getNextNode(chapter, "choice", "left")?.id).toBe("ending-a");
    expect(validatePlayableChapter(chapter, { availableAssetIds: new Set(["arrival-video"]) })).toBeUndefined();
    expect(validatePlayableChapter(chapter, { availableAssetIds: new Set() })).toEqual({ nodeId: "scene", message: "A video used by this scene is missing from Library." });
  });

  it("requires a video in every reachable scene", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push({ id: "empty", type: "scene", position: { x: 0, y: 0 }, data: { title: "Empty", clips: [], events: [] } });
    chapter.edges.push({ id: "start-empty", source: start.id, target: "empty" });

    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: "empty", message: "Add at least one video to the scene \"Empty\"." });
  });

  it("reports the first missing connection on a reachable path", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: start.id, message: "Connect Start to a next node." });

    chapter.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: { title: "Choose", options: [{ id: "only", label: "Continue" }] },
    });
    chapter.edges.push({ id: "edge", source: start.id, target: "choice" });
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: "choice", message: "Connect the choice \"Continue\"." });
  });

  it("allows loops and ignores disconnected draft nodes", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      { id: "loop", type: "scene", position: { x: 0, y: 0 }, data: { title: "Loop", clips: [{ id: "loop-clip", source: { type: "library", assetId: "loop-video" } }], events: [] } },
      { id: "draft", type: "scene", position: { x: 0, y: 0 }, data: { title: "Draft", clips: [], events: [] } },
    );
    chapter.edges.push(
      { id: "enter-loop", source: start.id, target: "loop" },
      { id: "repeat-loop", source: "loop", target: "loop" },
    );

    expect(validatePlayableChapter(chapter)).toBeUndefined();
  });

  it("accepts disconnected image generation nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "image",
      type: "image",
      position: { x: 240, y: 0 },
      data: {
        prompt: "A hero portrait",
        model: { provider: "opengame", id: "gpt-image-2" },
        resolution: "1K",
        aspectRatio: "1:1",
        images: [],
      },
    });

    expect(isStoryDocument(story)).toBe(true);
  });

  it("accepts text prompts linked to image and video nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push(
      { id: "prompt", type: "text", position: { x: 0, y: 0 }, data: { text: "A forest at dawn", instruction: "Write an image prompt" } },
      {
        id: "image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "", promptSource: { type: "node", nodeId: "prompt" }, resolution: "1K", aspectRatio: "1:1", images: [] },
      },
      {
        id: "video",
        type: "video",
        position: { x: 480, y: 0 },
        data: {
          prompt: "",
          promptSource: { type: "node", nodeId: "prompt" },
          model: VIDEO_MODEL,
          resolution: "720p",
          aspectRatio: "16:9",
          duration: 6,
          references: [],
        },
      },
    );

    expect(isStoryDocument(story)).toBe(true);
  });

  it("rejects prompt references to missing or non-text nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "image",
      type: "image",
      position: { x: 240, y: 0 },
      data: { prompt: "", promptSource: { type: "node", nodeId: "missing" }, resolution: "1K", aspectRatio: "1:1", images: [] },
    });
    expect(isStoryDocument(story)).toBe(false);

    const image = story.chapters[0]!.nodes.at(-1);
    if (image?.type === "image") image.data.promptSource = { type: "node", nodeId: story.chapters[0]!.nodes[0]!.id };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("rejects invalid image generation parameters", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "image",
      type: "image",
      position: { x: 240, y: 0 },
      data: { prompt: "A hero portrait", resolution: "1K", aspectRatio: "1:1", images: [] },
    });
    const image = story.chapters[0]!.nodes.at(-1)!;

    (image.data as { resolution: string }).resolution = "8K";

    expect(isStoryDocument(story)).toBe(false);
  });

  it("accepts disconnected video generation nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "video",
      type: "video",
      position: { x: 240, y: 0 },
      data: {
        prompt: "A slow camera move through a forest",
        model: VIDEO_MODEL,
        resolution: "720p",
        aspectRatio: "16:9",
        duration: 6,
        references: [],
      },
    });

    expect(isStoryDocument(story)).toBe(true);
  });

  it("accepts scene clips linked to video nodes and resolves their latest result", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      {
        id: "video",
        type: "video",
        position: { x: 240, y: 0 },
        data: {
          prompt: "A slow camera move through a forest",
          model: VIDEO_MODEL,
          resolution: "720p",
          aspectRatio: "16:9",
          duration: 6,
          references: [],
          assetId: "first-result",
        },
      },
      {
        id: "scene",
        type: "scene",
        position: { x: 600, y: 0 },
        data: { title: "Forest", clips: [{ id: "clip", source: { type: "node", nodeId: "video" } }], events: [] },
      },
    );
    const scene = chapter.nodes.find((node) => node.id === "scene");
    const clip = scene?.type === "scene" ? scene.data.clips[0]! : undefined;

    expect(isStoryDocument(story)).toBe(true);
    expect(resolveStoryVideoClipAssetId(chapter, clip!)).toBe("first-result");

    const video = chapter.nodes.find((node) => node.id === "video");
    if (video?.type === "video") video.data.assetId = "latest-result";
    expect(resolveStoryVideoClipAssetId(chapter, clip!)).toBe("latest-result");
  });

  it("rejects scene references to missing or non-video nodes", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      {
        id: "image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "A forest", resolution: "1K", aspectRatio: "1:1", images: [] },
      },
      {
        id: "scene",
        type: "scene",
        position: { x: 600, y: 0 },
        data: { title: "Forest", clips: [{ id: "clip", source: { type: "node", nodeId: "image" } }], events: [] },
      },
    );

    expect(isStoryDocument(story)).toBe(false);
    const scene = chapter.nodes.find((node) => node.id === "scene");
    if (scene?.type === "scene") scene.data.clips[0]!.source = { type: "node", nodeId: "missing" };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("requires a linked video node to have an available result before playtest", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      {
        id: "video",
        type: "video",
        position: { x: 240, y: 0 },
        data: { prompt: "A forest", model: VIDEO_MODEL, resolution: "720p", aspectRatio: "16:9", duration: 6, references: [] },
      },
      {
        id: "scene",
        type: "scene",
        position: { x: 600, y: 0 },
        data: { title: "Forest", clips: [{ id: "clip", source: { type: "node", nodeId: "video" } }], events: [] },
      },
      { id: "ending", type: "ending", position: { x: 900, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, target: "scene" },
      { id: "scene-ending", source: "scene", target: "ending" },
    );

    expect(validatePlayableChapter(chapter, { availableAssetIds: new Set() })).toEqual({
      nodeId: "scene",
      message: "A video used by this scene is missing from Library.",
    });
    const video = chapter.nodes.find((node) => node.id === "video");
    if (video?.type === "video") video.data.assetId = "generated-video";
    expect(validatePlayableChapter(chapter, { availableAssetIds: new Set(["generated-video"]) })).toBeUndefined();
  });

  it("validates image inputs and resolves the latest image-node result", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      {
        id: "image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "A forest", resolution: "1K", aspectRatio: "1:1", images: [], assetId: "first-image" },
      },
      {
        id: "video",
        type: "video",
        position: { x: 600, y: 0 },
        data: {
          prompt: "Leaves moving in the wind",
          model: VIDEO_MODEL,
          resolution: "720p",
          aspectRatio: "16:9",
          duration: 6,
          references: [{ type: "node", nodeId: "image" }],
        },
      },
    );
    const video = chapter.nodes.find((node) => node.id === "video");
    const reference = video?.type === "video" ? video.data.references[0]! : undefined;

    expect(isStoryDocument(story)).toBe(true);
    expect(resolveStoryImageAssetId(chapter, reference!)).toBe("first-image");
    const image = chapter.nodes.find((node) => node.id === "image");
    if (image?.type === "image") image.data.assetId = "latest-image";
    expect(resolveStoryImageAssetId(chapter, reference!)).toBe("latest-image");

    if (video?.type === "video") video.data.references = [{ type: "node", nodeId: chapter.nodes[0]!.id }];
    expect(isStoryDocument(story)).toBe(false);
  });

  it("accepts Library and generated images as image-generation references", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "library-image", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "library-image-id", mediaType: "image" } },
      {
        id: "generated-image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "Character portrait", resolution: "1K", aspectRatio: "1:1", images: [], assetId: "generated-image-id" },
      },
      {
        id: "composite-image",
        type: "image",
        position: { x: 480, y: 0 },
        data: {
          prompt: "Place the character in this environment",
          resolution: "1K",
          aspectRatio: "16:9",
          images: [{ type: "node", nodeId: "library-image" }, { type: "node", nodeId: "generated-image" }],
        },
      },
    );

    expect(isStoryDocument(story)).toBe(true);
    const composite = chapter.nodes.find((node) => node.id === "composite-image");
    const references = composite?.type === "image" ? composite.data.images : [];
    expect(resolveStoryImageAssetId(chapter, references[0]!)).toBe("library-image-id");
    expect(resolveStoryImageAssetId(chapter, references[1]!)).toBe("generated-image-id");

    if (composite?.type === "image") composite.data.images = [{ type: "node", nodeId: composite.id }];
    expect(isStoryDocument(story)).toBe(false);

    if (composite?.type === "image") composite.data.images = Array.from({ length: 15 }, () => ({ type: "library", assetId: "reference" }));
    expect(isStoryDocument(story)).toBe(false);
  });

  it("uses Library and generated media nodes as typed video sources", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "image-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "image-id", mediaType: "image" } },
      { id: "video-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "video-id", mediaType: "video" } },
      { id: "audio-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "audio-id", mediaType: "audio" } },
      {
        id: "video",
        type: "video",
        position: { x: 300, y: 0 },
        data: { prompt: "Animate", model: VIDEO_MODEL, resolution: "720p", aspectRatio: "16:9", duration: 6, references: [{ type: "node", nodeId: "image-asset" }, { type: "node", nodeId: "video-asset" }, { type: "node", nodeId: "audio-asset" }] },
      },
      { id: "scene", type: "scene", position: { x: 600, y: 0 }, data: { title: "Opening", clips: [{ id: "clip", source: { type: "node", nodeId: "video-asset" } }], events: [] } },
    );

    expect(isStoryDocument(story)).toBe(true);
    const video = chapter.nodes.find((node) => node.id === "video");
    const scene = chapter.nodes.find((node) => node.id === "scene");
    const references = video?.type === "video" ? video.data.references : [];
    expect(references.map((reference) => resolveStoryAssetId(chapter, reference))).toEqual(["image-id", "video-id", "audio-id"]);
    expect(resolveStoryVideoClipAssetId(chapter, scene?.type === "scene" ? scene.data.clips[0]! : { id: "", source: { type: "library", assetId: "" } })).toBe("video-id");
  });

  it("rejects invalid video generation parameters", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "video",
      type: "video",
      position: { x: 240, y: 0 },
      data: {
        prompt: "A slow camera move through a forest",
        model: VIDEO_MODEL,
        resolution: "720p",
        aspectRatio: "16:9",
        duration: 6,
        references: [],
      },
    });
    const video = story.chapters[0]!.nodes.at(-1)!;

    (video.data as { duration: number }).duration = 16;

    expect(isStoryDocument(story)).toBe(false);
  });

  it("replaces the existing connection from the same output", () => {
    const edges = [
      { id: "first", source: "choice", sourceHandle: "left", target: "scene-a" },
      { id: "second", source: "choice", sourceHandle: "right", target: "scene-b" },
    ];
    expect(replaceOutgoingEdge(edges, { id: "replacement", source: "choice", sourceHandle: "left", target: "scene-c" }))
      .toEqual([
        { id: "second", source: "choice", sourceHandle: "right", target: "scene-b" },
        { id: "replacement", source: "choice", sourceHandle: "left", target: "scene-c" },
      ]);
  });
});
