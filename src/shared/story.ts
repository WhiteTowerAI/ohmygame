import { IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_MODEL, VIDEO_RESOLUTIONS, type StoryAction, type StoryAssetReference, type StoryChapter, type StoryChoiceOption, type StoryDocument, type StoryEdge, type StoryInteractionOutcome, type StoryNode, type StoryOverlay, type StoryPlayerConfig, type StorySceneEvent, type StoryVariable, type StoryVariableCondition, type StoryVariableValue } from "./contracts.js";

const STORY_NODE_TYPES = new Set(["start", "scene", "choice", "ending", "text", "image", "video", "asset"]);
const STORY_OVERLAY_PLACEMENTS = new Set(["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]);

export const DEFAULT_STORY_PLAYER_CONFIG: StoryPlayerConfig = {
  title: "Untitled Story",
  theme: { accentColor: "#ffffff", textColor: "#ffffff", font: "sans" },
  videoFit: "contain",
  choicePosition: "bottom",
};

export function createStoryDocument(): StoryDocument {
  return {
    version: 7,
    variables: [],
    overlays: [],
    chapters: [{
      id: crypto.randomUUID(),
      title: "Untitled",
      nodes: [{ id: crypto.randomUUID(), type: "start", position: { x: 80, y: 180 }, data: {} }],
      edges: [],
    }],
  };
}

export function isStoryDocument(value: unknown): value is StoryDocument {
  if (!isRecord(value) || value.version !== 7 || !Array.isArray(value.chapters) || value.chapters.length === 0) return false;
  if (value.player !== undefined && !isPlayerConfig(value.player)) return false;
  if (value.variables !== undefined && !isVariables(value.variables)) return false;
  const variables = new Map((value.variables ?? []).map((variable) => [variable.id, variable]));
  if (value.overlays !== undefined && !isOverlays(value.overlays, variables)) return false;
  const overlays = new Set((value.overlays ?? []).map((overlay) => overlay.id));
  const chapterIds = new Set<string>();
  return value.chapters.every((chapter) => {
    if (!isRecord(chapter) || !nonEmptyString(chapter.id) || chapterIds.has(chapter.id) || typeof chapter.title !== "string" ||
      !Array.isArray(chapter.nodes) || !Array.isArray(chapter.edges)) return false;
    chapterIds.add(chapter.id);
    const nodes = chapter.nodes as unknown[];
    const nodeIds = new Set<string>();
    const nodeById = new Map<string, StoryNode>();
    for (const node of nodes) {
      if (!isStoryNode(node, variables, overlays) || nodeIds.has(node.id)) return false;
      nodeIds.add(node.id);
      nodeById.set(node.id, node);
    }
    for (const node of nodeById.values()) {
      if (node.type === "scene") {
        for (const clip of node.data.clips) {
          if (clip.source.type === "node" && !isVideoSourceNode(nodeById.get(clip.source.nodeId))) return false;
        }
      }
      if (node.type === "image") {
        for (const image of node.data.images) {
          if (image.type === "node" && (image.nodeId === node.id || !isImageSourceNode(nodeById.get(image.nodeId)))) return false;
        }
      }
      if (node.type === "video") {
        for (const reference of node.data.references) {
          if (reference.type === "node" && (reference.nodeId === node.id || !isVideoReferenceSourceNode(nodeById.get(reference.nodeId)))) return false;
        }
      }
      if ((node.type === "image" || node.type === "video") && node.data.promptSource &&
        nodeById.get(node.data.promptSource.nodeId)?.type !== "text") return false;
    }
    if (nodes.filter((node) => isRecord(node) && node.type === "start").length !== 1) return false;
    const edgeIds = new Set<string>();
    const outputs = new Set<string>();
    return (chapter.edges as unknown[]).every((edge) => {
      if (!isRecord(edge) || !nonEmptyString(edge.id) || edgeIds.has(edge.id) ||
        typeof edge.source !== "string" || typeof edge.target !== "string" ||
        !nodeIds.has(edge.source) || !nodeIds.has(edge.target) ||
        (edge.sourceHandle !== undefined && typeof edge.sourceHandle !== "string")) return false;
      const output = `${edge.source}\0${edge.sourceHandle ?? "out"}`;
      if (outputs.has(output)) return false;
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target || source.type === "ending" || isCanvasOnlyNode(source) || target.type === "start" || isCanvasOnlyNode(target)) return false;
      const handle = edge.sourceHandle ?? "out";
      if (source.type === "choice" ? !source.data.options.some((option) => option.id === handle)
        : source.type === "scene" ? handle !== "out" && !isSceneInteractionHandle(source.data.events, handle)
        : handle !== "out") return false;
      edgeIds.add(edge.id);
      outputs.add(output);
      return true;
    });
  });
}

export interface StoryPlayIssue {
  nodeId: string;
  message: string;
}

export function getStartNode(chapter: StoryChapter): StoryNode | undefined {
  return chapter.nodes.find((node) => node.type === "start");
}

export function getOutgoingEdge(chapter: StoryChapter, nodeId: string, sourceHandle = "out"): StoryEdge | undefined {
  return chapter.edges.find((edge) => edge.source === nodeId && (edge.sourceHandle ?? "out") === sourceHandle);
}

export function getNextNode(chapter: StoryChapter, nodeId: string, sourceHandle = "out"): StoryNode | undefined {
  const edge = getOutgoingEdge(chapter, nodeId, sourceHandle);
  return edge ? chapter.nodes.find((node) => node.id === edge.target) : undefined;
}

export function sceneInteractionHandle(eventId: string, result: "success" | "timeout"): string {
  return `interaction:${eventId}:${result}`;
}

export function resolveStoryVideoClipAssetId(chapter: StoryChapter, clip: Extract<StoryNode, { type: "scene" }>["data"]["clips"][number]): string | undefined {
  const reference = clip.source;
  if (reference.type === "library") return reference.assetId;
  const node = chapter.nodes.find((candidate) => candidate.id === reference.nodeId);
  if (node?.type === "video") return node.data.assetId;
  return node?.type === "asset" && node.data.mediaType === "video" ? node.data.assetId : undefined;
}

export function resolveStoryImageAssetId(chapter: StoryChapter, reference: StoryAssetReference): string | undefined {
  if (reference.type === "library") return reference.assetId;
  const node = chapter.nodes.find((candidate) => candidate.id === reference.nodeId);
  if (node?.type === "image") return node.data.assetId;
  return node?.type === "asset" && node.data.mediaType === "image" ? node.data.assetId : undefined;
}

export function resolveStoryAssetId(chapter: StoryChapter, reference: StoryAssetReference): string | undefined {
  if (reference.type === "library") return reference.assetId;
  const node = chapter.nodes.find((candidate) => candidate.id === reference.nodeId);
  return node?.type === "image" || node?.type === "video" || node?.type === "asset" ? node.data.assetId : undefined;
}

export function combineStoryPrompt(linkedText: string | undefined, localPrompt: string): string {
  return [linkedText, localPrompt].map((part) => part?.trim()).filter(Boolean).join("\n\n");
}

export function initialStoryVariables(variables: readonly StoryVariable[]): Record<string, StoryVariableValue> {
  return Object.fromEntries(variables.map((variable) => [variable.id, variable.initialValue]));
}

export interface StoryRuntimeState {
  chapterId: string;
  nodeId: string;
  variables: Record<string, StoryVariableValue>;
  visibleOverlayIds: string[];
}

export interface ScenePlaybackState {
  clipId: string;
  timeMs: number;
  firedEventIds: string[];
  waitingEventId?: string;
}

interface PlayerRuntimeStateBase {
  chapterId: string;
  variables: Record<string, StoryVariableValue>;
  visibleOverlayIds: string[];
}

export type PlayerRuntimeState =
  | PlayerRuntimeStateBase & { mode: "menu"; nodeId?: never }
  | PlayerRuntimeStateBase & { mode: "playing"; nodeId: string; scenePlayback?: ScenePlaybackState };

export type PlayingRuntimeState = Extract<PlayerRuntimeState, { mode: "playing" }>;

export interface StorySaveDataV1 {
  version: 1;
  storyVersion: 7;
  storySignature: string;
  savedAt: string;
  checkpoint: PlayingRuntimeState;
}

export function createStoryCheckpoint(storySignature: string, state: PlayerRuntimeState, savedAt = new Date().toISOString()): StorySaveDataV1 {
  if (!storySignature) throw new Error("Story signature is required");
  if (state.mode !== "playing") throw new Error("Only a playing state can be saved");
  return { version: 1, storyVersion: 7, storySignature, savedAt, checkpoint: clonePlayingState(state) };
}

export function restoreStoryCheckpoint(
  value: unknown,
  storySignature: string,
  chapter: StoryChapter,
  variables: readonly StoryVariable[],
  overlays: readonly StoryOverlay[],
): PlayingRuntimeState | undefined {
  if (!isRecord(value) || value.version !== 1 || value.storyVersion !== 7 || value.storySignature !== storySignature ||
    typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt)) || !isRecord(value.checkpoint)) return undefined;
  const checkpoint = value.checkpoint;
  if (checkpoint.mode !== "playing" || checkpoint.chapterId !== chapter.id || !nonEmptyString(checkpoint.nodeId) ||
    !isRecord(checkpoint.variables) || !Array.isArray(checkpoint.visibleOverlayIds)) return undefined;
  const definitions = new Map(variables.map((variable) => [variable.id, variable]));
  const values = Object.entries(checkpoint.variables);
  if (values.length !== definitions.size || values.some(([id, current]) => !variableValueMatches(definitions.get(id)?.type, current))) return undefined;
  const overlayIds = new Set(overlays.map((overlay) => overlay.id));
  if (!uniqueStrings(checkpoint.visibleOverlayIds) || checkpoint.visibleOverlayIds.some((id) => !overlayIds.has(id))) return undefined;
  const node = chapter.nodes.find((candidate) => candidate.id === checkpoint.nodeId);
  if (!node || node.type === "start" || isCanvasOnlyNode(node) || !reachableStoryNodeIds(chapter).has(node.id)) return undefined;
  if (node.type !== "scene") {
    if (checkpoint.scenePlayback !== undefined) return undefined;
  } else if (!validSavedScenePlayback(node, checkpoint.scenePlayback)) {
    return undefined;
  }
  return clonePlayingState(checkpoint as unknown as PlayingRuntimeState);
}

export function shouldCreateStoryCheckpoint(previous: PlayingRuntimeState | undefined, next: PlayerRuntimeState): next is PlayingRuntimeState {
  if (next.mode !== "playing") return false;
  if (!previous || previous.chapterId !== next.chapterId || previous.nodeId !== next.nodeId) return true;
  if (!sameRecord(previous.variables, next.variables) || !sameStrings(previous.visibleOverlayIds, next.visibleOverlayIds)) return true;
  const before = previous.scenePlayback;
  const after = next.scenePlayback;
  if (!before || !after) return before !== after;
  return before.clipId !== after.clipId || before.waitingEventId !== after.waitingEventId || !sameStrings(before.firedEventIds, after.firedEventIds);
}

export function createPlayerState(chapterId: string, variables: readonly StoryVariable[]): PlayerRuntimeState {
  return { mode: "menu", chapterId, variables: initialStoryVariables(variables), visibleOverlayIds: [] };
}

export function startGame(chapter: StoryChapter, state: PlayerRuntimeState): PlayingRuntimeState {
  if (state.chapterId !== chapter.id) throw new Error("Runtime state belongs to a different chapter");
  if (state.mode !== "menu") throw new Error("The game has already started");
  const start = getStartNode(chapter);
  const first = start ? getNextNode(chapter, start.id) : undefined;
  if (!first) throw new Error("The chapter has no opening node");
  return enterStoryNode({ ...state, mode: "playing" }, first);
}

function advanceFromScene(chapter: StoryChapter, state: PlayingRuntimeState): PlayingRuntimeState {
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "scene") throw new Error("The current story node is not a scene");
  const next = getNextNode(chapter, node.id);
  if (!next) throw new Error("The scene is not connected");
  return enterStoryNode(state, next);
}

export function chooseOption(chapter: StoryChapter, state: PlayerRuntimeState, optionId: string): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const resolved = resolveStoryChoice(chapter, state, optionId);
  const next = chapter.nodes.find((node) => node.id === resolved.nodeId);
  if (!next) throw new Error("The selected choice points to a missing node");
  return enterStoryNode({ ...state, ...resolved, mode: "playing" }, next);
}

export function restartGame(chapter: StoryChapter, variables: readonly StoryVariable[]): PlayingRuntimeState {
  return startGame(chapter, createPlayerState(chapter.id, variables));
}

export function advanceSceneTime(chapter: StoryChapter, state: PlayerRuntimeState, clipId: string, timeMs: number): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error("Scene time must be a non-negative finite number");
  const { node, playback } = currentScenePlayback(chapter, state, clipId);
  if (playback.waitingEventId || timeMs <= playback.timeMs) return state;
  return runSceneEvents(state, node, playback, timeMs);
}

export function continueSceneEvent(chapter: StoryChapter, state: PlayerRuntimeState): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const { node, playback } = currentScenePlayback(chapter, state);
  if (!playback.waitingEventId) throw new Error("The scene is not waiting for Continue");
  if (node.data.events.find((event) => event.id === playback.waitingEventId)?.type !== "continue") throw new Error("The scene is not waiting for Continue");
  const resumed: PlayingRuntimeState = {
    ...state,
    scenePlayback: {
      ...playback,
      firedEventIds: [...playback.firedEventIds, playback.waitingEventId],
      waitingEventId: undefined,
    },
  };
  return runSceneEvents(resumed, node, resumed.scenePlayback!, resumed.scenePlayback!.timeMs);
}

export function resolveSceneInteraction(chapter: StoryChapter, state: PlayerRuntimeState, eventId: string, result: "success" | "timeout"): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const { node, playback } = currentScenePlayback(chapter, state);
  if (playback.waitingEventId !== eventId) throw new Error("The interaction is not active");
  const event = node.data.events.find((candidate) => candidate.id === eventId);
  if (!event || (event.type !== "hotspot" && event.type !== "qte")) throw new Error("The active event is not an interaction");
  const outcome = event[result];
  const applied = applyRuntimeActions(state, outcome.actions);
  const resumed: PlayingRuntimeState = {
    ...state,
    ...applied,
    scenePlayback: {
      ...playback,
      firedEventIds: [...playback.firedEventIds, event.id],
      waitingEventId: undefined,
    },
  };
  if (outcome.transition === "branch") {
    const next = getNextNode(chapter, node.id, sceneInteractionHandle(event.id, result));
    if (!next) throw new Error(`The ${result} outcome is not connected`);
    return enterStoryNode(resumed, next);
  }
  return runSceneEvents(resumed, node, resumed.scenePlayback!, resumed.scenePlayback!.timeMs);
}

export function completeSceneClip(chapter: StoryChapter, state: PlayerRuntimeState, clipId: string, durationMs: number): PlayingRuntimeState {
  const advanced = advanceSceneTime(chapter, state, clipId, durationMs);
  const { node, playback } = currentScenePlayback(chapter, advanced, clipId);
  if (playback.waitingEventId) return advanced;
  const clipIndex = node.data.clips.findIndex((clip) => clip.id === clipId);
  const nextClip = node.data.clips[clipIndex + 1];
  if (nextClip) return beginSceneClip(advanced, node, nextClip.id);
  return advanceFromScene(chapter, advanced);
}

function enterStoryNode(state: PlayerRuntimeStateBase & { mode: "playing" }, node: StoryNode): PlayingRuntimeState {
  const entered = { ...state, nodeId: node.id, scenePlayback: undefined };
  return node.type === "scene" && node.data.clips[0]
    ? beginSceneClip(entered, node, node.data.clips[0].id)
    : entered;
}

function beginSceneClip(state: PlayingRuntimeState, node: Extract<StoryNode, { type: "scene" }>, clipId: string): PlayingRuntimeState {
  const playback: ScenePlaybackState = { clipId, timeMs: 0, firedEventIds: [] };
  return runSceneEvents({ ...state, scenePlayback: playback }, node, playback, 0);
}

function runSceneEvents(state: PlayingRuntimeState, node: Extract<StoryNode, { type: "scene" }>, playback: ScenePlaybackState, timeMs: number): PlayingRuntimeState {
  let variables = state.variables;
  let visibleOverlayIds = state.visibleOverlayIds;
  let nextPlayback = { ...playback, timeMs };
  const fired = new Set(playback.firedEventIds);
  const due = node.data.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.clipId === playback.clipId && !fired.has(event.id) && event.timeMs >= playback.timeMs && event.timeMs <= timeMs)
    .sort((left, right) => left.event.timeMs - right.event.timeMs || left.index - right.index);
  for (const { event } of due) {
    if (event.type === "continue" || event.type === "hotspot" || event.type === "qte") {
      nextPlayback = { ...nextPlayback, timeMs: event.timeMs, waitingEventId: event.id };
      break;
    }
    ({ variables, visibleOverlayIds } = applyRuntimeActions({ variables, visibleOverlayIds }, event.actions));
    fired.add(event.id);
    nextPlayback = { ...nextPlayback, firedEventIds: [...fired] };
  }
  return { ...state, variables, visibleOverlayIds, scenePlayback: nextPlayback };
}

function currentScenePlayback(chapter: StoryChapter, state: PlayingRuntimeState, clipId?: string): { node: Extract<StoryNode, { type: "scene" }>; playback: ScenePlaybackState } {
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "scene" || !state.scenePlayback) throw new Error("The current story node is not a scene");
  if (clipId !== undefined && state.scenePlayback.clipId !== clipId) throw new Error("The clip is not active");
  return { node, playback: state.scenePlayback };
}

export function matchesStoryCondition(condition: StoryVariableCondition | undefined, values: Readonly<Record<string, StoryVariableValue>>): boolean {
  if (!condition) return true;
  const current = values[condition.variableId];
  if (condition.operator === "equals") return current === condition.value;
  if (condition.operator === "not-equals") return current !== condition.value;
  if (typeof current !== "number" || typeof condition.value !== "number") return false;
  return condition.operator === "greater-than" ? current > condition.value : current < condition.value;
}

export function applyStoryActions(actions: readonly StoryAction[] | undefined, values: Readonly<Record<string, StoryVariableValue>>): Record<string, StoryVariableValue> {
  return applyRuntimeActions({ variables: values, visibleOverlayIds: [] }, actions).variables;
}

export function applyRuntimeActions(state: { variables: Readonly<Record<string, StoryVariableValue>>; visibleOverlayIds: readonly string[] }, actions: readonly StoryAction[] | undefined): { variables: Record<string, StoryVariableValue>; visibleOverlayIds: string[] } {
  const variables = { ...state.variables };
  const visibleOverlayIds = [...state.visibleOverlayIds];
  for (const action of actions ?? []) {
    if (action.type === "set-variable") variables[action.variableId] = action.value;
    else if (action.type === "increment-variable") {
      const current = variables[action.variableId];
      if (typeof current !== "number") throw new Error(`Cannot increment non-number variable: ${action.variableId}`);
      const incremented = current + action.amount;
      if (!Number.isFinite(incremented)) throw new Error(`Variable increment is not finite: ${action.variableId}`);
      variables[action.variableId] = incremented;
    } else if (action.type === "show-overlay") {
      if (!visibleOverlayIds.includes(action.overlayId)) visibleOverlayIds.push(action.overlayId);
    } else {
      const index = visibleOverlayIds.indexOf(action.overlayId);
      if (index >= 0) visibleOverlayIds.splice(index, 1);
    }
  }
  return { variables, visibleOverlayIds };
}

export function resolveStoryChoice(chapter: StoryChapter, state: StoryRuntimeState, optionId: string): StoryRuntimeState {
  if (state.chapterId !== chapter.id) throw new Error("Runtime state belongs to a different chapter");
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "choice") throw new Error("The current story node is not a choice");
  const option = node.data.options.find((candidate) => candidate.id === optionId);
  if (!option || !matchesStoryCondition(option.condition, state.variables)) throw new Error("The selected choice is not available");
  const next = getNextNode(chapter, node.id, option.id);
  if (!next) throw new Error("The selected choice is not connected");
  return { ...state, nodeId: next.id, ...applyRuntimeActions(state, option.actions) };
}

export function countStoryVariableReferences(options: readonly StoryChoiceOption[], variableId: string): number {
  return options.reduce((count, option) => count + Number(option.condition?.variableId === variableId) + (option.actions ?? []).filter((action) => "variableId" in action && action.variableId === variableId).length, 0);
}

export function removeStoryVariableReferences(options: readonly StoryChoiceOption[], variableId: string): StoryChoiceOption[] {
  return options.map((option) => {
    const actions = option.actions?.filter((action) => !("variableId" in action) || action.variableId !== variableId);
    return {
      ...option,
      ...(option.condition?.variableId === variableId ? { condition: undefined } : {}),
      ...(actions?.length ? { actions } : { actions: undefined }),
    };
  });
}

export function normalizeStoryVariableReferences(options: readonly StoryChoiceOption[], variables: ReadonlyMap<string, StoryVariable>): StoryChoiceOption[] {
  return options.map((option) => {
    const actions = normalizeActions(option.actions ?? [], variables);
    return {
      ...option,
      ...(option.condition ? { condition: normalizeCondition(option.condition, variables.get(option.condition.variableId)) } : {}),
      ...(actions.length ? { actions } : { actions: undefined }),
    };
  });
}

export function countSceneVariableReferences(events: readonly StorySceneEvent[], variableId: string): number {
  return events.reduce((count, event) => count + sceneEventActions(event).filter((action) => "variableId" in action && action.variableId === variableId).length, 0);
}

export function removeSceneVariableReferences(events: readonly StorySceneEvent[], variableId: string): StorySceneEvent[] {
  return events.map((event) => mapSceneEventActions(event, (actions) => actions.filter((action) => !("variableId" in action) || action.variableId !== variableId)));
}

export function normalizeSceneVariableReferences(events: readonly StorySceneEvent[], variables: ReadonlyMap<string, StoryVariable>): StorySceneEvent[] {
  return events.map((event) => mapSceneEventActions(event, (actions) => normalizeActions(actions, variables)));
}

function sceneEventActions(event: StorySceneEvent): StoryAction[] {
  if (event.type === "actions") return event.actions;
  return event.type === "hotspot" || event.type === "qte" ? [...event.success.actions, ...event.timeout.actions] : [];
}

function mapSceneEventActions(event: StorySceneEvent, update: (actions: StoryAction[]) => StoryAction[]): StorySceneEvent {
  if (event.type === "actions") return { ...event, actions: update(event.actions) };
  return event.type === "hotspot" || event.type === "qte"
    ? { ...event, success: { ...event.success, actions: update(event.success.actions) }, timeout: { ...event.timeout, actions: update(event.timeout.actions) } }
    : event;
}

export function normalizeOverlayVariableReferences(overlays: readonly StoryOverlay[], variables: ReadonlyMap<string, StoryVariable>): StoryOverlay[] {
  return overlays.map((overlay) => ({
    ...overlay,
    ...(overlay.condition ? { condition: normalizeCondition(overlay.condition, variables.get(overlay.condition.variableId)) } : {}),
    components: overlay.components.filter((component) => component.type !== "value" && component.type !== "meter" ||
      variables.has(component.variableId) && (component.type !== "meter" || variables.get(component.variableId)?.type === "number")),
  }));
}

function normalizeActions(actions: readonly StoryAction[], variables: ReadonlyMap<string, StoryVariable>): StoryAction[] {
  return actions.reduce<StoryAction[]>((normalized, action) => {
    if (action.type === "show-overlay" || action.type === "hide-overlay") {
      normalized.push(action);
      return normalized;
    }
    const variable = variables.get(action.variableId);
    if (!variable || (action.type === "increment-variable" && variable.type !== "number")) return normalized;
    normalized.push(action.type === "set-variable"
      ? { ...action, value: variableValue(action.value, variable.type) }
      : { ...action, amount: Number.isFinite(action.amount) ? action.amount : 0 });
    return normalized;
  }, []);
}

export function parseStoryDocument(value: unknown): StoryDocument {
  const migrated = migrateStoryDocument(value);
  if (!isStoryDocument(migrated)) throw new Error("Invalid story document");
  return migrated;
}

function migrateStoryDocument(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.chapters)) return value;
  const version4 = value.version === 3 ? {
    ...value,
    version: 4,
    chapters: value.chapters.map((chapter) => !isRecord(chapter) || !Array.isArray(chapter.nodes) ? chapter : ({
      ...chapter,
      nodes: chapter.nodes.map(migrateStoryNode),
    })),
  } : value;
  const version5 = version4.version === 4 && Array.isArray(version4.chapters) ? {
    ...version4,
    version: 5,
    chapters: version4.chapters.map((chapter) => !isRecord(chapter) || !Array.isArray(chapter.nodes) ? chapter : ({
      ...chapter,
      nodes: chapter.nodes.map((node) => !isRecord(node) || node.type !== "scene" || !isRecord(node.data)
        ? node
        : { ...node, data: { ...node.data, events: [] } }),
    })),
  } : version4;
  const version6 = version5.version === 5 ? { ...version5, version: 6, overlays: [] } : version5;
  if (version6.version !== 6) return version6;
  return { ...version6, version: 7 };
}

function migrateStoryNode(node: unknown): unknown {
  if (!isRecord(node) || node.type !== "choice" || !isRecord(node.data) || !Array.isArray(node.data.options)) return node;
  return {
    ...node,
    data: {
      ...node.data,
      options: node.data.options.map((option) => {
        if (!isRecord(option)) return option;
        const { effect, ...rest } = option;
        return effect === undefined ? rest : { ...rest, actions: [{ type: "set-variable", ...(isRecord(effect) ? effect : {}) }] };
      }),
    },
  };
}

export function replaceOutgoingEdge<T extends { source: string; sourceHandle?: string | null }>(edges: T[], next: T): T[] {
  const nextHandle = next.sourceHandle ?? "out";
  return [
    ...edges.filter((edge) => edge.source !== next.source || (edge.sourceHandle ?? "out") !== nextHandle),
    next,
  ];
}

export interface StoryPlayValidationOptions {
  availableAssetIds?: ReadonlySet<string>;
  assetDurationsMs?: ReadonlyMap<string, number>;
}

export function validatePlayableChapter(chapter: StoryChapter, options: StoryPlayValidationOptions = {}): StoryPlayIssue | undefined {
  const start = getStartNode(chapter);
  if (!start) return { nodeId: "", message: "This chapter has no Start node." };
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    if (node.type === "ending") continue;
    if (isCanvasOnlyNode(node)) continue;
    if (node.type === "scene" && node.data.clips.length === 0) return {
      nodeId: node.id,
      message: `Add at least one video to the scene "${node.data.title || "Untitled scene"}".`,
    };
    if (node.type === "scene" && options.availableAssetIds) {
      const missing = node.data.clips.find((clip) => {
        const assetId = resolveStoryVideoClipAssetId(chapter, clip);
        return !assetId || !options.availableAssetIds!.has(assetId);
      });
      if (missing) return { nodeId: node.id, message: "A video used by this scene is missing from Library." };
    }
    if (node.type === "scene" && options.assetDurationsMs) {
      for (const event of node.data.events) {
        const clip = node.data.clips.find((candidate) => candidate.id === event.clipId);
        if (!clip) continue;
        const assetId = resolveStoryVideoClipAssetId(chapter, clip);
        const source = clip.source;
        const sourceNode = source.type === "node" ? chapter.nodes.find((candidate) => candidate.id === source.nodeId) : undefined;
        const durationMs = assetId ? options.assetDurationsMs.get(assetId) : undefined;
        const knownDurationMs = durationMs ?? (sourceNode?.type === "video" ? sourceNode.data.duration * 1_000 : undefined);
        if (knownDurationMs !== undefined && event.timeMs > knownDurationMs) return {
          nodeId: node.id,
          message: `An event in "${node.data.title || "Untitled scene"}" is after its video clip ends.`,
        };
      }
    }
    const handles = node.type === "choice" ? node.data.options.map((option) => option.id)
      : node.type === "scene" ? ["out", ...node.data.events.flatMap((event) => event.type === "hotspot" || event.type === "qte"
        ? (["success", "timeout"] as const).flatMap((result) => event[result].transition === "branch" ? [sceneInteractionHandle(event.id, result)] : [])
        : [])]
      : ["out"];
    for (const handle of handles) {
      const edge = getOutgoingEdge(chapter, node.id, handle);
      if (!edge) return {
        nodeId: node.id,
        message: node.type === "choice"
          ? `Connect the choice "${node.data.options.find((option) => option.id === handle)?.label || "Untitled option"}".`
          : node.type === "scene" && handle !== "out"
            ? `Connect the ${handle.endsWith(":success") ? "success" : "timeout"} outcome in "${node.data.title || "Untitled scene"}".`
            : `Connect ${node.type === "start" ? "Start" : `the scene "${node.data.title || "Untitled scene"}"`} to a next node.`,
      };
      const target = chapter.nodes.find((candidate) => candidate.id === edge.target);
      if (!target) return { nodeId: node.id, message: "A connection points to a missing node." };
      pending.push(target);
    }
  }
  return undefined;
}

function isStoryNode(value: unknown, variables: ReadonlyMap<string, StoryVariable>, overlays: ReadonlySet<string>): value is StoryNode {
  if (!isRecord(value) || !nonEmptyString(value.id) || typeof value.type !== "string" ||
    !STORY_NODE_TYPES.has(value.type) || !isPosition(value.position) || !isRecord(value.data)) return false;
  if (value.type === "start") return Object.keys(value.data).length === 0;
  if (value.type === "scene") {
    if (typeof value.data.title !== "string") return false;
    if (!Array.isArray(value.data.clips) || !Array.isArray(value.data.events)) return false;
    const clipIds = new Set<string>();
    if (!value.data.clips.every((clip) => {
      if (!isRecord(clip) || !nonEmptyString(clip.id) || clipIds.has(clip.id) || !isAssetReference(clip.source)) return false;
      clipIds.add(clip.id);
      return true;
    })) return false;
    const eventIds = new Set<string>();
    return value.data.events.every((event) => {
      if (!isRecord(event) || !nonEmptyString(event.id) || eventIds.has(event.id) || !clipIds.has(String(event.clipId)) ||
        typeof event.timeMs !== "number" || !Number.isInteger(event.timeMs) || event.timeMs < 0) return false;
      eventIds.add(event.id);
      if (event.type === "actions") return Array.isArray(event.actions) && event.actions.every((action) => isAction(action, variables, overlays));
      if (event.type === "continue") return typeof event.label === "string" && event.label.length <= 80;
      if ((event.type !== "hotspot" && event.type !== "qte") || !validInteractionDuration(event.durationMs) ||
        !isOutcome(event.success, variables, overlays) || !isOutcome(event.timeout, variables, overlays)) return false;
      if (event.type === "qte") return typeof event.prompt === "string" && event.prompt.length <= 120 && isQteKey(event.key);
      return typeof event.label === "string" && event.label.length <= 80 && isHotspotRegion(event.region);
    });
  }
  if (value.type === "ending") {
    return typeof value.data.title === "string" && typeof value.data.description === "string";
  }
  if (value.type === "asset") return nonEmptyString(value.data.assetId) &&
    (value.data.mediaType === "image" || value.data.mediaType === "video" || value.data.mediaType === "audio") &&
    Object.keys(value.data).length === 2;
  if (value.type === "text") return typeof value.data.text === "string" &&
    typeof value.data.instruction === "string" &&
    (value.data.model === undefined || isModelRef(value.data.model));
  if (value.type === "image") {
    const data = value.data;
    return typeof data.prompt === "string" &&
      (data.promptSource === undefined || isTextReference(data.promptSource)) &&
      (data.model === undefined || isModelRef(data.model)) &&
      typeof data.resolution === "string" && IMAGE_RESOLUTIONS.some((resolution) => resolution === data.resolution) &&
      typeof data.aspectRatio === "string" && IMAGE_ASPECT_RATIOS.some((aspectRatio) => aspectRatio === data.aspectRatio) &&
      Array.isArray(data.images) && data.images.length <= 14 && data.images.every(isAssetReference) &&
      (data.assetId === undefined || nonEmptyString(data.assetId));
  }
  if (value.type === "video") {
    const data = value.data;
    return typeof data.prompt === "string" &&
      (data.promptSource === undefined || isTextReference(data.promptSource)) && data.model === VIDEO_MODEL &&
      typeof data.resolution === "string" && VIDEO_RESOLUTIONS.some((resolution) => resolution === data.resolution) &&
      typeof data.aspectRatio === "string" && VIDEO_ASPECT_RATIOS.some((aspectRatio) => aspectRatio === data.aspectRatio) &&
      typeof data.duration === "number" && Number.isInteger(data.duration) && data.duration >= 4 && data.duration <= 15 &&
      Array.isArray(data.references) && data.references.length <= 15 && data.references.every(isAssetReference) &&
      (data.assetId === undefined || nonEmptyString(data.assetId));
  }
  if (value.type !== "choice" || typeof value.data.title !== "string" || !Array.isArray(value.data.options) || value.data.options.length < 1) return false;
  const optionIds = new Set<string>();
  const validOptions = value.data.options.every((option) => {
    if (!isRecord(option) || !nonEmptyString(option.id) || optionIds.has(option.id) || typeof option.label !== "string") return false;
    if (option.condition !== undefined && !isCondition(option.condition, variables)) return false;
    if (option.actions !== undefined && (!Array.isArray(option.actions) || !option.actions.every((action) => isAction(action, variables, overlays)))) return false;
    optionIds.add(option.id);
    return true;
  });
  if (!validOptions) return false;
  if (value.data.timeout === undefined) return true;
  const timeout = value.data.timeout;
  return isRecord(timeout) && typeof timeout.durationMs === "number" && Number.isInteger(timeout.durationMs) &&
    timeout.durationMs >= 1_000 && timeout.durationMs <= 300_000 && nonEmptyString(timeout.defaultOptionId) && optionIds.has(timeout.defaultOptionId);
}

function isSceneInteractionHandle(events: readonly StorySceneEvent[], handle: string): boolean {
  return events.some((event) => (event.type === "hotspot" || event.type === "qte") &&
    ((event.success.transition === "branch" && handle === sceneInteractionHandle(event.id, "success")) ||
      (event.timeout.transition === "branch" && handle === sceneInteractionHandle(event.id, "timeout"))));
}

function validInteractionDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 500 && value <= 60_000;
}

function isOutcome(value: unknown, variables: ReadonlyMap<string, StoryVariable>, overlays: ReadonlySet<string>): value is StoryInteractionOutcome {
  return isRecord(value) && (value.transition === "continue" || value.transition === "branch") &&
    Array.isArray(value.actions) && value.actions.every((action) => isAction(action, variables, overlays));
}

function isHotspotRegion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { x, y, width, height } = value;
  return [x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part)) &&
    Number(width) > 0 && Number(height) > 0 && Number(x) >= 0 && Number(y) >= 0 &&
    Number(x) + Number(width) <= 1 && Number(y) + Number(height) <= 1;
}

function isQteKey(value: unknown): boolean {
  return typeof value === "string" && /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Enter)$/.test(value);
}

function isVariables(value: unknown): value is StoryVariable[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((candidate) => {
    if (!isRecord(candidate) || !nonEmptyString(candidate.id) || ids.has(candidate.id) || typeof candidate.name !== "string" || candidate.name.length > 80) return false;
    if (!variableValueMatches(candidate.type, candidate.initialValue)) return false;
    ids.add(candidate.id);
    return true;
  });
}

function isPlayerConfig(value: unknown): value is StoryPlayerConfig {
  if (!isRecord(value) || typeof value.title !== "string" || value.title.length > 120 ||
    (value.backgroundAssetId !== undefined && !nonEmptyString(value.backgroundAssetId)) ||
    (value.videoFit !== "contain" && value.videoFit !== "cover") ||
    (value.choicePosition !== "center" && value.choicePosition !== "bottom") || !isRecord(value.theme)) return false;
  return /^#[0-9a-f]{6}$/i.test(String(value.theme.accentColor)) &&
    /^#[0-9a-f]{6}$/i.test(String(value.theme.textColor)) &&
    (value.theme.font === "sans" || value.theme.font === "serif");
}

function isOverlays(value: unknown, variables: ReadonlyMap<string, StoryVariable>): value is StoryOverlay[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((overlay) => {
    if (!isRecord(overlay) || !nonEmptyString(overlay.id) || ids.has(overlay.id) || typeof overlay.name !== "string" || overlay.name.length > 80 ||
      !STORY_OVERLAY_PLACEMENTS.has(String(overlay.placement)) || !Array.isArray(overlay.components) ||
      (overlay.condition !== undefined && !isCondition(overlay.condition, variables))) return false;
    ids.add(overlay.id);
    const componentIds = new Set<string>();
    return overlay.components.every((component) => {
      if (!isRecord(component) || !nonEmptyString(component.id) || componentIds.has(component.id)) return false;
      componentIds.add(component.id);
      if (component.type === "text") return typeof component.text === "string" && component.text.length <= 500;
      if (component.type === "image") return nonEmptyString(component.assetId) && typeof component.alt === "string" && component.alt.length <= 120;
      if (component.type === "value") return typeof component.label === "string" && component.label.length <= 80 && variables.has(String(component.variableId));
      if (component.type !== "meter" || typeof component.label !== "string" || component.label.length > 80) return false;
      const variable = variables.get(String(component.variableId));
      return variable?.type === "number" && typeof component.min === "number" && Number.isFinite(component.min) &&
        typeof component.max === "number" && Number.isFinite(component.max) && component.max > component.min;
    });
  });
}

function isCondition(value: unknown, variables: ReadonlyMap<string, StoryVariable>): boolean {
  if (!isRecord(value) || !nonEmptyString(value.variableId) || !["equals", "not-equals", "greater-than", "less-than"].includes(String(value.operator))) return false;
  const variable = variables.get(value.variableId);
  return Boolean(variable && variableValueMatches(variable.type, value.value) &&
    (variable.type === "number" || value.operator === "equals" || value.operator === "not-equals"));
}

function normalizeCondition(condition: StoryVariableCondition, variable?: StoryVariable): StoryVariableCondition | undefined {
  if (!variable) return undefined;
  const operator = variable.type === "number" || condition.operator === "equals" || condition.operator === "not-equals"
    ? condition.operator
    : "equals";
  return { ...condition, operator, value: variableValue(condition.value, variable.type) };
}

function variableValue(value: StoryVariableValue, type: StoryVariable["type"]): StoryVariableValue {
  if (type === "boolean") return typeof value === "boolean" ? value : false;
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? value : 0;
  return typeof value === "string" ? value : "";
}

function isAction(value: unknown, variables: ReadonlyMap<string, StoryVariable>, overlays: ReadonlySet<string>): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "show-overlay" || value.type === "hide-overlay") return nonEmptyString(value.overlayId) && overlays.has(value.overlayId);
  if (!nonEmptyString(value.variableId)) return false;
  const variable = variables.get(value.variableId);
  if (!variable) return false;
  if (value.type === "set-variable") return variableValueMatches(variable.type, value.value);
  return value.type === "increment-variable" && variable.type === "number" && typeof value.amount === "number" && Number.isFinite(value.amount);
}

function variableValueMatches(type: unknown, value: unknown): boolean {
  return type === "boolean" ? typeof value === "boolean" : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "text" && typeof value === "string";
}

function validSavedScenePlayback(node: Extract<StoryNode, { type: "scene" }>, value: unknown): value is ScenePlaybackState {
  if (!isRecord(value) || !nonEmptyString(value.clipId) || !Number.isInteger(value.timeMs) || Number(value.timeMs) < 0 ||
    !Array.isArray(value.firedEventIds) || !uniqueStrings(value.firedEventIds) ||
    (value.waitingEventId !== undefined && !nonEmptyString(value.waitingEventId))) return false;
  if (!node.data.clips.some((clip) => clip.id === value.clipId)) return false;
  const due = node.data.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.clipId === value.clipId && event.timeMs <= Number(value.timeMs))
    .sort((left, right) => left.event.timeMs - right.event.timeMs || left.index - right.index)
    .map(({ event }) => event);
  if (!value.firedEventIds.every((id, index) => due[index]?.id === id)) return false;
  if (value.waitingEventId === undefined) return value.firedEventIds.length === due.length;
  const waiting = due[value.firedEventIds.length];
  return Boolean(waiting && waiting.id === value.waitingEventId && waiting.timeMs === value.timeMs &&
    (waiting.type === "continue" || waiting.type === "hotspot" || waiting.type === "qte"));
}

function reachableStoryNodeIds(chapter: StoryChapter): Set<string> {
  const start = getStartNode(chapter);
  const reachable = new Set<string>();
  const pending = start ? [start.id] : [];
  while (pending.length) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of chapter.edges) if (edge.source === nodeId) pending.push(edge.target);
  }
  return reachable;
}

function clonePlayingState(state: PlayingRuntimeState): PlayingRuntimeState {
  return {
    ...state,
    variables: { ...state.variables },
    visibleOverlayIds: [...state.visibleOverlayIds],
    ...(state.scenePlayback ? { scenePlayback: { ...state.scenePlayback, firedEventIds: [...state.scenePlayback.firedEventIds] } } : {}),
  };
}

function uniqueStrings(value: unknown[]): value is string[] {
  return value.every((item) => typeof item === "string") && new Set(value).size === value.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecord(left: Readonly<Record<string, StoryVariableValue>>, right: Readonly<Record<string, StoryVariableValue>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function isPosition(value: unknown): boolean {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isModelRef(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.provider) && nonEmptyString(value.id);
}

function isAssetReference(value: unknown): boolean {
  return isRecord(value) && (
    (value.type === "library" && nonEmptyString(value.assetId) && Object.keys(value).length === 2) ||
    (value.type === "node" && nonEmptyString(value.nodeId) && Object.keys(value).length === 2)
  );
}

function isTextReference(value: unknown): boolean {
  return isRecord(value) && value.type === "node" && nonEmptyString(value.nodeId) && Object.keys(value).length === 2;
}

function isCanvasOnlyNode(node: StoryNode): node is Extract<StoryNode, { type: "text" | "image" | "video" | "asset" }> {
  return node.type === "text" || node.type === "image" || node.type === "video" || node.type === "asset";
}

function isImageSourceNode(node: StoryNode | undefined): boolean {
  return node?.type === "image" || (node?.type === "asset" && node.data.mediaType === "image");
}

function isVideoSourceNode(node: StoryNode | undefined): boolean {
  return node?.type === "video" || (node?.type === "asset" && node.data.mediaType === "video");
}

function isVideoReferenceSourceNode(node: StoryNode | undefined): boolean {
  return node?.type === "image" || node?.type === "video" || node?.type === "asset";
}
