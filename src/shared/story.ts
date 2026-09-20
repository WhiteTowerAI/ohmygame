import { IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_MODEL, VIDEO_RESOLUTIONS, type StoryAction, type StoryAssetReference, type StoryChapter, type StoryChoiceOption, type StoryDocument, type StoryEdge, type StoryEditorLayout, type StoryInteractionCommand, type StorySurfaceFiles, type StoryNode, type StoryNodePresentation, type StoryOpenUiContent, type StoryOpenUiAction, type StoryPlayerConfig, type StorySceneMedia, type StorySourceFiles, type StoryVariable, type StoryVariableCondition, type StoryVariableValue } from "./contracts.js";

const STORY_NODE_TYPES = new Set(["start", "update-state", "condition", "open-ui", "scene", "interaction", "choice", "ending", "text", "image", "video", "asset"]);
const MAX_AUTOMATIC_STORY_STEPS = 100;

export const DEFAULT_OPEN_UI_CODE: StorySurfaceFiles = {
    html: `<main class="open-ui">
  <h1 data-content="title"></h1>
  <div class="actions" data-content="buttons"></div>
</main>`,
    css: `* { box-sizing: border-box; }
body { margin: 0; color: #fff; font-family: Inter, system-ui, sans-serif; }
.open-ui { min-height: 100vh; display: grid; place-content: center; justify-items: center; gap: 18px; padding: 48px; text-align: center; }
h1 { margin: 0; font-size: clamp(42px, 8vw, 88px); line-height: 1; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
button { margin-top: 18px; padding: 12px 22px; border: 1px solid #44d6b2; border-radius: 7px; background: rgb(68 214 178 / 14%); color: inherit; font: inherit; cursor: pointer; }
`,
    javascript: `export function render({ content, actions, root }) {
  root.querySelector('[data-content="title"]').textContent = content.title;
  const buttons = root.querySelector('[data-content="buttons"]');
  buttons.replaceChildren(...content.buttons.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.addEventListener("click", () => actions.run(item.action));
    return button;
  }));
}`,
};

export const DEFAULT_OPEN_UI_CONTENT: StoryOpenUiContent = {
  title: "Untitled Story",
  buttons: [
    { id: "enter-game", label: "Start game", action: "enter-game" },
  ],
};

export const DEFAULT_STORY_PLAYER_CONFIG: StoryPlayerConfig = {
  title: "Untitled Story",
  viewport: { width: 1280, height: 720 },
  theme: { accentColor: "#ffffff", textColor: "#ffffff", font: "sans" },
  videoFit: "contain",
  choicePosition: "bottom",
};

export function defaultStoryNodeSource(nodeId: string): StorySourceFiles {
  const readable = nodeId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "definition";
  let hash = 2166136261;
  for (const character of nodeId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const base = `nodes/${readable}-${(hash >>> 0).toString(36)}`;
  return {
    html: `${base}/index.html`,
    css: `${base}/style.css`,
    javascript: `${base}/script.js`,
  };
}

export function openUiRuntimeContent(content: StoryOpenUiContent, hasCheckpoint: boolean): StoryOpenUiContent {
  return {
    ...content,
    buttons: content.buttons.map((button) => button.action === "enter-game"
      ? { ...button, label: hasCheckpoint ? "Continue" : "Start game" }
      : button),
  };
}

export function transparentStorySurfaceFiles(files: StorySurfaceFiles, rootSelector?: string): StorySurfaceFiles {
  const selectors = rootSelector ? `html,body,${rootSelector}` : "html,body";
  return { ...files, css: `${files.css}\n${selectors}{background:transparent!important}` };
}

export const DEFAULT_SCENE_SURFACE_FILES: StorySurfaceFiles = {
  html: '<div id="scene-root"></div>',
  css: 'html, body, #scene-root { width: 100%; height: 100%; margin: 0; background: transparent; }',
  javascript: 'export function render() {}\n',
};

export const DEFAULT_CHOICE_SURFACE_FILES: StorySurfaceFiles = {
  html: '<main class="choice"><span>Choice</span><h1 data-title></h1><div data-options></div><small data-timer></small></main>',
  css: `* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; background: transparent; }
body { display: grid; place-items: center; color: #fff; font-family: Inter, system-ui, sans-serif; }
.choice { display: grid; width: min(78%, 620px); justify-items: center; text-align: center; text-shadow: 0 1px 5px rgb(0 0 0 / 76%); }
.choice > span { color: rgb(255 255 255 / 68%); font-size: 12px; font-weight: 700; text-transform: uppercase; }
h1 { max-width: 100%; margin: 8px 0 18px; font-size: 28px; }
[data-options] { display: grid; width: min(100%, 440px); gap: 8px; }
button { min-height: 42px; padding: 8px 16px; border: 1px solid rgb(255 255 255 / 48%); border-radius: 5px; background: rgb(9 10 13 / 70%); color: #fff; font: inherit; font-weight: 600; cursor: pointer; backdrop-filter: blur(7px); }
button:hover { border-color: #fff; background: rgb(255 255 255 / 18%); }
[data-timer] { margin-top: 12px; color: rgb(255 255 255 / 72%); }`,
  javascript: `export function render({ node, actions, root }) {
  root.querySelector('[data-title]').textContent = node.title || 'Make a choice';
  const options = root.querySelector('[data-options]');
  options.replaceChildren(...node.options.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = (index + 1) + '. ' + (item.label || ('Option ' + (index + 1)));
    button.addEventListener('click', () => actions.choose(item.id));
    return button;
  }));
  const timer = root.querySelector('[data-timer]');
  timer.textContent = node.remainingMs == null ? '' : Math.max(0, Math.ceil(node.remainingMs / 1000)) + 's';
}`,
};

export const DEFAULT_ENDING_SURFACE_FILES: StorySurfaceFiles = {
  html: '<main class="ending"><span>Ending</span><h1 data-title></h1><p data-description></p><div><button data-action="restart">Play again</button><button data-action="menu">Main menu</button></div></main>',
  css: `* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; background: transparent; }
body { display: grid; place-items: center; color: #fff; font-family: Inter, system-ui, sans-serif; }
.ending { display: grid; width: min(78%, 620px); justify-items: center; text-align: center; text-shadow: 0 1px 5px rgb(0 0 0 / 76%); }
.ending > span { color: rgb(255 255 255 / 68%); font-size: 12px; font-weight: 700; text-transform: uppercase; }
h1 { margin: 9px 0 0; font-size: 46px; }
p { max-width: 520px; margin: 14px 0 0; color: rgb(255 255 255 / 78%); line-height: 1.5; }
.ending > div { display: flex; gap: 10px; margin-top: 24px; }
button { min-height: 40px; padding: 8px 16px; border: 1px solid rgb(255 255 255 / 42%); border-radius: 5px; background: rgb(9 10 13 / 70%); color: #fff; font: inherit; cursor: pointer; }
button:hover { border-color: #fff; background: rgb(255 255 255 / 18%); }`,
  javascript: `export function render({ node, actions, root }) {
  root.querySelector('[data-title]').textContent = node.title || 'Untitled ending';
  const description = root.querySelector('[data-description]');
  description.textContent = node.description || '';
  description.hidden = !node.description;
  root.querySelector('[data-action="restart"]').onclick = () => actions.restart();
  root.querySelector('[data-action="menu"]').onclick = () => actions.menu();
}`,
};

export function storyNodePresentation(node: Extract<StoryNode, { type: "open-ui" | "scene" | "interaction" | "choice" | "ending" }>): StoryNodePresentation {
  return node.data.presentation;
}

function isPresentationNode(node: StoryNode): node is Extract<StoryNode, { type: "open-ui" | "scene" | "interaction" | "choice" | "ending" }> {
  return node.type === "open-ui" || node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

export function createStoryDocument(): StoryDocument {
  return {
    version: 1,
    editorLayout: { version: 1, nodes: {}, viewport: { x: 64, y: 32, zoom: 1 }, view: "canvas" },
    variables: [],
    player: structuredClone(DEFAULT_STORY_PLAYER_CONFIG),
    chapter: { id: crypto.randomUUID(), title: "Untitled", nodes: [], edges: [] },
  };
}

export function isStoryDocument(value: unknown): value is StoryDocument {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.chapter)) return false;
  if (!hasOnlyKeys(value, ["version", "editorLayout", "player", "variables", "chapter"])) return false;
  if (!isEditorLayout(value.editorLayout) || !isPlayerConfig(value.player) || !isVariables(value.variables)) return false;
  const variables = new Map(value.variables.map((variable) => [variable.id, variable]));
  const sourcePaths = storyRecords(value.chapter.nodes).flatMap((node) => {
    const data = isRecord(node.data) ? node.data : undefined;
    const presentation = data && isRecord(data.presentation) ? data.presentation : undefined;
    const surface = presentation && isRecord(presentation.surface) ? presentation.surface : undefined;
    const source = surface && isRecord(surface.source) ? surface.source : undefined;
    return ["open-ui", "scene", "interaction", "choice", "ending"].includes(String(node.type)) && source && typeof source.html === "string" && typeof source.css === "string" && typeof source.javascript === "string"
      ? [source.html, source.css, source.javascript]
      : [];
  });
  if (new Set(sourcePaths).size !== sourcePaths.length) return false;
  const chapter = value.chapter;
  if (!hasOnlyKeys(chapter, ["id", "title", "nodes", "edges"]) || !nonEmptyString(chapter.id) || typeof chapter.title !== "string" ||
    !Array.isArray(chapter.nodes) || !Array.isArray(chapter.edges)) return false;
  const nodes = chapter.nodes as unknown[];
  const nodeIds = new Set<string>();
  const nodeById = new Map<string, StoryNode>();
  for (const node of nodes) {
    if (!isStoryNode(node, variables) || nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    nodeById.set(node.id, node);
  }
  for (const node of nodeById.values()) {
    if (node.type === "open-ui" || node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending") {
      const presentation = node.data.presentation;
      if (presentation?.media.mode === "own") {
        for (const item of presentation.media.items) {
          if (item.source.type !== "node") continue;
          if (item.source.nodeId === node.id || !isPresentationMediaSourceNode(nodeById.get(item.source.nodeId), item.type)) return false;
        }
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
  if (nodes.filter((node) => isRecord(node) && node.type === "start").length > 1) return false;
  const edgeIds = new Set<string>();
  const outputs = new Set<string>();
  const validEdges = (chapter.edges as unknown[]).every((edge) => {
    if (!isRecord(edge) || !nonEmptyString(edge.id) || edgeIds.has(edge.id) ||
      typeof edge.source !== "string" || typeof edge.target !== "string" ||
      !nodeIds.has(edge.source) || !nodeIds.has(edge.target) ||
      (edge.sourceHandle !== undefined && typeof edge.sourceHandle !== "string") ||
      !hasOnlyKeys(edge, ["id", "source", "target", "sourceHandle"])) return false;
    const output = `${edge.source}\0${edge.sourceHandle ?? "out"}`;
    if (outputs.has(output)) return false;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target || source.type === "ending" || isCanvasOnlyNode(source) || target.type === "start" || isCanvasOnlyNode(target)) return false;
    const handle = edge.sourceHandle ?? "out";
    if (source.type === "choice" ? !source.data.options.some((option) => option.id === handle)
      : source.type === "interaction" ? !source.data.outcomes.includes(handle)
      : source.type === "condition" ? handle !== "true" && handle !== "false"
      : handle !== "out") return false;
    edgeIds.add(edge.id);
    outputs.add(output);
    return true;
  });
  if (!validEdges) return false;
  const layoutIds = Object.keys((value.editorLayout as StoryEditorLayout).nodes);
  return layoutIds.length === nodeIds.size && layoutIds.every((id) => nodeIds.has(id));
}

function isPresentationMediaSourceNode(node: StoryNode | undefined, type: StorySceneMedia["type"]): boolean {
  return type === "image" ? isImageSourceNode(node) : isVideoSourceNode(node);
}

export interface StoryPlayIssue {
  nodeId: string;
  message: string;
}

export function getStartNode(chapter: StoryChapter): StoryNode | undefined {
  return chapter.nodes.find((node) => node.type === "start");
}

export function isEntryOpenUiNode(chapter: StoryChapter, nodeId: string): boolean {
  const start = getStartNode(chapter);
  return Boolean(start && getNextNode(chapter, start.id)?.id === nodeId);
}

export function getOutgoingEdge(chapter: StoryChapter, nodeId: string, sourceHandle = "out"): StoryEdge | undefined {
  return chapter.edges.find((edge) => edge.source === nodeId && (edge.sourceHandle ?? "out") === sourceHandle);
}

export function getNextNode(chapter: StoryChapter, nodeId: string, sourceHandle = "out"): StoryNode | undefined {
  const edge = getOutgoingEdge(chapter, nodeId, sourceHandle);
  return edge ? chapter.nodes.find((node) => node.id === edge.target) : undefined;
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
}

export interface ScenePlaybackState {
  mediaId: string;
  timeMs: number;
}

export interface PresentationMediaState {
  nodeId: string;
  mediaId: string;
}

interface PlayerRuntimeStateBase {
  chapterId: string;
  variables: Record<string, StoryVariableValue>;
  progress?: StoryProgressFacts;
  presentationMedia?: PresentationMediaState;
}

export interface StoryProgressFacts {
  currentNodeId?: string;
  visitedNodeIds: string[];
  selectedOptionIds: string[];
  unlockedEndingIds: string[];
}

export type PlayerRuntimeState =
  | PlayerRuntimeStateBase & { mode: "menu"; nodeId?: never }
  | PlayerRuntimeStateBase & { mode: "playing"; nodeId: string; scenePlayback?: ScenePlaybackState };

export type PlayingRuntimeState = Extract<PlayerRuntimeState, { mode: "playing" }>;

export interface StorySaveDataV1 {
  version: 1;
  storyVersion: 1;
  storySignature: string;
  savedAt: string;
  checkpoint: PlayingRuntimeState;
}

export function createStoryCheckpoint(storySignature: string, state: PlayerRuntimeState, savedAt = new Date().toISOString()): StorySaveDataV1 {
  if (!storySignature) throw new Error("Story signature is required");
  if (state.mode !== "playing") throw new Error("Only a playing state can be saved");
  return { version: 1, storyVersion: 1, storySignature, savedAt, checkpoint: clonePlayingState(state) };
}

export function restoreStoryCheckpoint(
  value: unknown,
  storySignature: string,
  chapter: StoryChapter,
  variables: readonly StoryVariable[],
): PlayingRuntimeState | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "storyVersion", "storySignature", "savedAt", "checkpoint"]) || value.version !== 1 || value.storyVersion !== 1 || value.storySignature !== storySignature ||
    typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt)) || !isRecord(value.checkpoint)) return undefined;
  const checkpoint = value.checkpoint;
  if (checkpoint.mode !== "playing" || checkpoint.chapterId !== chapter.id || !nonEmptyString(checkpoint.nodeId) ||
    !isRecord(checkpoint.variables) || !hasOnlyKeys(checkpoint, ["mode", "chapterId", "nodeId", "variables", "progress", "scenePlayback", "presentationMedia"])) return undefined;
  const definitions = new Map(variables.map((variable) => [variable.id, variable]));
  const values = Object.entries(checkpoint.variables);
  if (values.length !== definitions.size || values.some(([id, current]) => !variableValueMatches(definitions.get(id)?.type, current))) return undefined;
  const node = chapter.nodes.find((candidate) => candidate.id === checkpoint.nodeId);
  if (!node || node.type === "start" || node.type === "update-state" || node.type === "condition" || node.type === "open-ui" || isCanvasOnlyNode(node) || !reachableStoryNodeIds(chapter).has(node.id)) return undefined;
  if (node.type !== "scene") {
    if (checkpoint.scenePlayback !== undefined) return undefined;
  } else {
    const media = node.data.presentation.media;
    const hasPlayableMedia = media.mode === "own" && media.items.length > 0;
    if (hasPlayableMedia ? !validSavedScenePlayback(node, checkpoint.scenePlayback) : checkpoint.scenePlayback !== undefined) return undefined;
  }
  if (!validPresentationMediaState(chapter, checkpoint.presentationMedia)) return undefined;
  return clonePlayingState({
    ...(checkpoint as unknown as PlayingRuntimeState),
    progress: validStoryProgressFacts(checkpoint.progress, chapter) ?? progressFromCurrentNode(checkpoint.nodeId, chapter),
  });
}

export function shouldCreateStoryCheckpoint(previous: PlayingRuntimeState | undefined, next: PlayerRuntimeState): next is PlayingRuntimeState {
  if (next.mode !== "playing") return false;
  if (!previous || previous.chapterId !== next.chapterId || previous.nodeId !== next.nodeId) return true;
  if (!sameRecord(previous.variables, next.variables)) return true;
  const before = previous.scenePlayback;
  const after = next.scenePlayback;
  if (!before || !after) return before !== after;
  return before.mediaId !== after.mediaId;
}

export function createPlayerState(chapterId: string, variables: readonly StoryVariable[]): PlayerRuntimeState {
  return { mode: "menu", chapterId, variables: initialStoryVariables(variables), progress: { visitedNodeIds: [], selectedOptionIds: [], unlockedEndingIds: [] } };
}

export function startGame(chapter: StoryChapter, state: PlayerRuntimeState): PlayingRuntimeState {
  if (state.chapterId !== chapter.id) throw new Error("Runtime state belongs to a different chapter");
  if (state.mode !== "menu") throw new Error("The game has already started");
  const start = getStartNode(chapter);
  const first = start ? getNextNode(chapter, start.id) : undefined;
  if (!first) throw new Error("The chapter has no opening node");
  return enterStoryNode(chapter, { ...state, progress: addStoryProgress(state.progress, { nodeId: start?.id }), mode: "playing" }, first);
}

function advanceFromScene(chapter: StoryChapter, state: PlayingRuntimeState): PlayingRuntimeState {
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "scene") throw new Error("The current story node is not a scene");
  const next = getNextNode(chapter, node.id);
  if (!next) throw new Error("The scene is not connected");
  return enterStoryNode(chapter, state, next);
}

export function chooseOption(chapter: StoryChapter, state: PlayerRuntimeState, optionId: string): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const resolved = resolveStoryChoice(chapter, state, optionId);
  const next = chapter.nodes.find((node) => node.id === resolved.nodeId);
  if (!next) throw new Error("The selected choice points to a missing node");
  return enterStoryNode(chapter, { ...state, ...resolved, progress: addStoryProgress(state.progress, { optionId }), mode: "playing" }, next);
}

export function resolveInteractionNode(
  chapter: StoryChapter,
  state: PlayerRuntimeState,
  result: string,
  commands: readonly StoryInteractionCommand[] = [],
  variables: readonly StoryVariable[] = [],
): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "interaction") throw new Error("The current node is not an Interaction");
  const handle = node.data.outcomes.includes(result) ? result : undefined;
  if (!handle || !result || result.length > 80) throw new Error("The Interaction outcome is invalid");
  const applied = applyStoryInteractionCommands(state.variables, commands, variables);
  const next = getNextNode(chapter, node.id, handle);
  if (!next) throw new Error(`The ${result} outcome is not connected`);
  return enterStoryNode(chapter, { ...state, variables: applied }, next);
}

export function restartGame(chapter: StoryChapter, variables: readonly StoryVariable[]): PlayingRuntimeState {
  return startGame(chapter, createPlayerState(chapter.id, variables));
}

export function advanceSceneTime(chapter: StoryChapter, state: PlayerRuntimeState, mediaId: string, timeMs: number): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error("Scene time must be a non-negative finite number");
  const { playback } = currentScenePlayback(chapter, state, mediaId);
  if (timeMs <= playback.timeMs) return state;
  return { ...state, scenePlayback: { ...playback, timeMs } };
}

function applyStoryInteractionCommands(
  state: Readonly<Record<string, StoryVariableValue>>,
  commands: readonly StoryInteractionCommand[],
  definitions: readonly StoryVariable[],
): Record<string, StoryVariableValue> {
  let next = { ...state };
  for (const command of commands) {
    const matches = definitions.filter((definition) => definition.id === command.variable || definition.name === command.variable);
    if (matches.length !== 1) throw new Error(matches.length ? `Variable name is ambiguous: ${command.variable}` : `Unknown variable: ${command.variable}`);
    const variable = matches[0]!;
    if (command.type === "increment-variable") {
      if (variable.type !== "number" || typeof command.amount !== "number" || !Number.isFinite(command.amount)) throw new Error(`${variable.name || variable.id} is not a number variable`);
      next = applyRuntimeActions(next, [{ type: "update-variable", variableId: variable.id, operator: "add", value: command.amount }]);
    } else {
      if (!variableValueMatches(variable.type, command.value)) throw new Error(`Value does not match ${variable.name || variable.id}`);
      next = applyRuntimeActions(next, [{ type: "update-variable", variableId: variable.id, operator: "set", value: command.value }]);
    }
  }
  return next;
}

export function completeSceneMedia(chapter: StoryChapter, state: PlayerRuntimeState, mediaId: string, durationMs: number): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const current = chapter.nodes.find((node) => node.id === state.nodeId);
  if (current?.type === "scene" && !state.scenePlayback) return advanceFromScene(chapter, state);
  const advanced = advanceSceneTime(chapter, state, mediaId, durationMs);
  const { node } = currentScenePlayback(chapter, advanced, mediaId);
  const media = node.data.presentation.media;
  const items = media.mode === "own" ? media.items : [];
  const next = items[items.findIndex((item) => item.id === mediaId) + 1];
  return next ? {
    ...advanced,
    presentationMedia: { nodeId: node.id, mediaId: next.id },
    scenePlayback: { mediaId: next.id, timeMs: 0 },
  } : advanceFromScene(chapter, advanced);
}

function enterStoryNode(chapter: StoryChapter, state: PlayerRuntimeStateBase & { mode: "playing" }, node: StoryNode): PlayingRuntimeState {
  let currentState = state;
  let currentNode = node;
  let automaticSteps = 0;
  while (true) {
    const presentation = isPresentationNode(currentNode) ? currentNode.data.presentation : undefined;
    const ownMedia = presentation?.media.mode === "own" ? presentation.media.items[0] : undefined;
    const presentationMedia = presentation?.media.mode === "none"
      ? undefined
      : ownMedia
        ? { nodeId: currentNode.id, mediaId: ownMedia.id }
        : currentState.presentationMedia;
    const entered = {
      ...currentState,
      progress: addStoryProgress(currentState.progress, { nodeId: currentNode.id, endingId: currentNode.type === "ending" ? currentNode.id : undefined }),
      nodeId: currentNode.id,
      presentationMedia,
      scenePlayback: undefined,
    };
    if (currentNode.type === "update-state") {
      if (++automaticSteps > MAX_AUTOMATIC_STORY_STEPS) throw new Error("Story has too many consecutive automatic nodes");
      const next = getNextNode(chapter, currentNode.id);
      if (!next) throw new Error("Update State is not connected");
      currentState = { ...entered, variables: applyRuntimeActions(entered.variables, currentNode.data.actions) };
      currentNode = next;
      continue;
    }
    if (currentNode.type === "condition") {
      if (++automaticSteps > MAX_AUTOMATIC_STORY_STEPS) throw new Error("Story has too many consecutive automatic nodes");
      if (!currentNode.data.condition) throw new Error("Condition is not configured");
      const outcome = matchesStoryCondition(currentNode.data.condition, entered.variables) ? "true" : "false";
      const next = getNextNode(chapter, currentNode.id, outcome);
      if (!next) throw new Error(`Condition ${outcome} outcome is not connected`);
      currentState = entered;
      currentNode = next;
      continue;
    }
    const media = currentNode.type === "scene" ? currentNode.data.presentation.media : undefined;
    const firstMedia = media?.mode === "own" ? media.items[0] : undefined;
    return currentNode.type === "scene" && firstMedia
      ? { ...entered, scenePlayback: { mediaId: firstMedia.id, timeMs: 0 } }
      : entered;
  }
}

export function resolvePresentationMedia(chapter: StoryChapter, state: { presentationMedia?: PresentationMediaState }): StorySceneMedia | undefined {
  const reference = state.presentationMedia;
  if (!reference) return undefined;
  const owner = chapter.nodes.find((node) => node.id === reference.nodeId);
  if (!owner || !isPresentationNode(owner) || owner.data.presentation.media.mode !== "own") return undefined;
  return owner.data.presentation.media.items.find((item) => item.id === reference.mediaId);
}

export function advanceOpenUi(chapter: StoryChapter, state: PlayerRuntimeState): PlayingRuntimeState {
  if (state.mode !== "playing") throw new Error("The game is not playing");
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "open-ui") throw new Error("The current story node is not Open UI");
  const next = getNextNode(chapter, node.id);
  if (!next) throw new Error("Open UI is not connected");
  return enterStoryNode(chapter, state, next);
}

function currentScenePlayback(chapter: StoryChapter, state: PlayingRuntimeState, mediaId?: string): { node: Extract<StoryNode, { type: "scene" }>; playback: ScenePlaybackState } {
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "scene" || !state.scenePlayback) throw new Error("The current story node is not a scene");
  if (mediaId !== undefined && state.scenePlayback.mediaId !== mediaId) throw new Error("The media item is not active");
  return { node, playback: state.scenePlayback };
}

export function matchesStoryCondition(condition: StoryVariableCondition | undefined, values: Readonly<Record<string, StoryVariableValue>>): boolean {
  if (!condition) return true;
  const current = values[condition.variableId];
  if (condition.operator === "equals") return current === condition.value;
  if (condition.operator === "not-equals") return current !== condition.value;
  if (typeof current !== "number" || typeof condition.value !== "number") return false;
  if (condition.operator === "greater-than") return current > condition.value;
  if (condition.operator === "greater-than-or-equal") return current >= condition.value;
  if (condition.operator === "less-than") return current < condition.value;
  return current <= condition.value;
}

export function applyStoryActions(actions: readonly StoryAction[] | undefined, values: Readonly<Record<string, StoryVariableValue>>): Record<string, StoryVariableValue> {
  return applyRuntimeActions(values, actions);
}

export function applyRuntimeActions(values: Readonly<Record<string, StoryVariableValue>>, actions: readonly StoryAction[] | undefined): Record<string, StoryVariableValue> {
  const variables = { ...values };
  for (const action of actions ?? []) {
    if (action.operator === "set") {
      variables[action.variableId] = action.value;
      continue;
    }
    const current = variables[action.variableId];
    if (typeof current !== "number" || typeof action.value !== "number") throw new Error(`Cannot apply ${action.operator} to non-number variable: ${action.variableId}`);
    const result = action.operator === "add" ? current + action.value
      : action.operator === "subtract" ? current - action.value
        : action.operator === "multiply" ? current * action.value
          : current / action.value;
    if (!Number.isFinite(result)) throw new Error(`Variable result is not finite: ${action.variableId}`);
    variables[action.variableId] = result;
  }
  return variables;
}

export function resolveStoryChoice(chapter: StoryChapter, state: StoryRuntimeState, optionId: string): StoryRuntimeState {
  if (state.chapterId !== chapter.id) throw new Error("Runtime state belongs to a different chapter");
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "choice") throw new Error("The current story node is not a choice");
  const option = node.data.options.find((candidate) => candidate.id === optionId);
  if (!option || !matchesStoryCondition(option.condition, state.variables)) throw new Error("The selected choice is not available");
  const next = getNextNode(chapter, node.id, option.id);
  if (!next) throw new Error("The selected choice is not connected");
  return { ...state, nodeId: next.id, variables: applyRuntimeActions(state.variables, option.actions) };
}

export function normalizeStoryVariableReferences(options: readonly StoryChoiceOption[], variables: ReadonlyMap<string, StoryVariable>): StoryChoiceOption[] {
  return options.map((option) => {
    const actions = normalizeStoryActions(option.actions ?? [], variables);
    return {
      ...option,
      ...(option.condition ? { condition: normalizeStoryCondition(option.condition, variables.get(option.condition.variableId)) } : {}),
      ...(actions.length ? { actions } : { actions: undefined }),
    };
  });
}

export function normalizeStoryActions(actions: readonly StoryAction[], variables: ReadonlyMap<string, StoryVariable>): StoryAction[] {
  return actions.reduce<StoryAction[]>((normalized, action) => {
    const variable = variables.get(action.variableId);
    if (!variable || (action.operator !== "set" && variable.type !== "number")) return normalized;
    normalized.push({ ...action, value: variableValue(action.value, variable.type) });
    return normalized;
  }, []);
}

export function parseStoryDocument(value: unknown): StoryDocument {
  if (!isStoryDocument(value)) throw new Error("Invalid story document");
  return value;
}

function isNodePresentation(value: unknown): value is StoryNodePresentation {
  if (!isRecord(value) || !isRecord(value.media) || !isRecord(value.surface) ||
    !hasOnlyKeys(value, ["media", "surface"]) || !hasOnlyKeys(value.surface, ["source", "files"]) ||
    (value.surface.source !== undefined && !isSourceFiles(value.surface.source)) || !isSurfaceFiles(value.surface.files)) return false;
  if (value.media.mode === "inherit" || value.media.mode === "none") return Object.keys(value.media).length === 1;
  if (value.media.mode !== "own" || !Array.isArray(value.media.items)) return false;
  const ids = new Set<string>();
  return value.media.items.every((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["id", "type", "source"]) || !nonEmptyString(item.id) || ids.has(item.id) || (item.type !== "image" && item.type !== "video") || !isAssetReference(item.source)) return false;
    ids.add(item.id);
    return true;
  });
}

function storyRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function replaceOutgoingEdge<T extends { source: string; sourceHandle?: string | null }>(edges: T[], next: T): T[] {
  const nextHandle = next.sourceHandle ?? "out";
  return [
    ...edges.filter((edge) => edge.source !== next.source || (edge.sourceHandle ?? "out") !== nextHandle),
    next,
  ];
}

export interface StoryPlayValidationOptions {
  availableAssets?: ReadonlyMap<string, "image" | "video" | "audio">;
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
    if (isCanvasOnlyNode(node)) continue;
    if (isPresentationNode(node) && options.availableAssets) {
      const media = node.data.presentation.media;
      const missing = media.mode === "own" && media.items.find((item) => {
        const assetId = resolveStoryAssetId(chapter, item.source);
        return !assetId || options.availableAssets!.get(assetId) !== item.type;
      });
      if (missing) return { nodeId: node.id, message: `Media used by this ${node.type} is missing from Library or has the wrong type.` };
    }
    if (node.type === "ending") continue;
    if (node.type === "condition" && !node.data.condition) return { nodeId: node.id, message: `Configure "${node.data.title || "Condition"}" before playtesting.` };
    const handles = node.type === "choice" ? node.data.options.map((option) => option.id)
      : node.type === "interaction" ? node.data.outcomes
      : node.type === "condition" ? ["true", "false"]
      : ["out"];
    for (const handle of handles) {
      const edge = getOutgoingEdge(chapter, node.id, handle);
      if (!edge) return {
        nodeId: node.id,
        message: node.type === "choice"
          ? `Connect the choice "${node.data.options.find((option) => option.id === handle)?.label || "Untitled option"}".`
          : node.type === "interaction" && handle !== "out"
              ? `Connect the ${handle} outcome in "${node.data.title || "Untitled interaction"}".`
            : node.type === "condition"
              ? `Connect the ${handle} outcome in "${node.data.title || "Condition"}".`
            : node.type === "update-state"
              ? `Connect ${node.data.title || "Update State"} to the next story node.`
              : `Connect ${node.type === "start" ? "Start" : `the scene "${node.data.title || "Untitled scene"}"`} to a next node.`,
      };
      const target = chapter.nodes.find((candidate) => candidate.id === edge.target);
      if (!target) return { nodeId: node.id, message: "A connection points to a missing node." };
      pending.push(target);
    }
  }
  return undefined;
}

function isStoryNode(value: unknown, variables: ReadonlyMap<string, StoryVariable>): value is StoryNode {
  if (!isRecord(value) || !nonEmptyString(value.id) || typeof value.type !== "string" ||
    !STORY_NODE_TYPES.has(value.type) || !isPosition(value.position) || !isRecord(value.data) ||
    !hasOnlyKeys(value, ["id", "type", "position", "data"])) return false;
  if (value.type === "start") return Object.keys(value.data).length === 0;
  if (value.type === "update-state") return typeof value.data.title === "string" && Array.isArray(value.data.actions) &&
    value.data.actions.every((action) => isAction(action, variables)) && hasOnlyKeys(value.data, ["title", "actions"]);
  if (value.type === "condition") return typeof value.data.title === "string" && (value.data.condition === undefined || isCondition(value.data.condition, variables)) &&
    hasOnlyKeys(value.data, ["title", "condition"]);
  if (["open-ui", "scene", "interaction", "choice", "ending"].includes(value.type) && !isNodePresentation(value.data.presentation)) return false;
  if (value.type === "open-ui") {
    const presentation = value.data.presentation as StoryNodePresentation;
    return typeof value.data.title === "string" && isOpenUiContent(value.data.content) &&
      (presentation.media.mode !== "own" || presentation.media.items.length <= 1) &&
      hasOnlyKeys(value.data, ["title", "content", "presentation"]);
  }
  if (value.type === "scene") {
    return typeof value.data.title === "string" && Object.keys(value.data).every((key) => key === "title" || key === "presentation");
  }
  if (value.type === "interaction") {
    const data = value.data;
    const outcomes = isInteractionOutcomes(data.outcomes) ? data.outcomes : undefined;
    const presentation = data.presentation as StoryNodePresentation;
    return typeof data.title === "string" &&
      (presentation.media.mode !== "own" || presentation.media.items.length <= 1) &&
      outcomes !== undefined &&
      (data.timeout === undefined || isInteractionTimeout(data.timeout, outcomes)) &&
      Object.keys(data).every((key) => key === "title" || key === "outcomes" || key === "timeout" || key === "presentation");
  }
  if (value.type === "ending") {
    const presentation = value.data.presentation as StoryNodePresentation;
    return typeof value.data.title === "string" && typeof value.data.description === "string" &&
      (presentation.media.mode !== "own" || presentation.media.items.length <= 1) &&
      hasOnlyKeys(value.data, ["title", "description", "presentation"]);
  }
  if (value.type === "asset") return nonEmptyString(value.data.assetId) &&
    (value.data.mediaType === "image" || value.data.mediaType === "video" || value.data.mediaType === "audio") &&
    Object.keys(value.data).length === 2;
  if (value.type === "text") return typeof value.data.text === "string" &&
    typeof value.data.instruction === "string" &&
    (value.data.model === undefined || isModelRef(value.data.model)) &&
    hasOnlyKeys(value.data, ["text", "instruction", "model"]);
  if (value.type === "image") {
    const data = value.data;
    return typeof data.prompt === "string" &&
      (data.promptSource === undefined || isTextReference(data.promptSource)) &&
      (data.model === undefined || isModelRef(data.model)) &&
      typeof data.resolution === "string" && IMAGE_RESOLUTIONS.some((resolution) => resolution === data.resolution) &&
      typeof data.aspectRatio === "string" && IMAGE_ASPECT_RATIOS.some((aspectRatio) => aspectRatio === data.aspectRatio) &&
      Array.isArray(data.images) && data.images.length <= 14 && data.images.every(isAssetReference) &&
      (data.assetId === undefined || nonEmptyString(data.assetId)) &&
      hasOnlyKeys(data, ["prompt", "promptSource", "model", "resolution", "aspectRatio", "images", "assetId"]);
  }
  if (value.type === "video") {
    const data = value.data;
    return typeof data.prompt === "string" &&
      (data.promptSource === undefined || isTextReference(data.promptSource)) && data.model === VIDEO_MODEL &&
      typeof data.resolution === "string" && VIDEO_RESOLUTIONS.some((resolution) => resolution === data.resolution) &&
      typeof data.aspectRatio === "string" && VIDEO_ASPECT_RATIOS.some((aspectRatio) => aspectRatio === data.aspectRatio) &&
      typeof data.duration === "number" && Number.isInteger(data.duration) && data.duration >= 4 && data.duration <= 15 &&
      Array.isArray(data.references) && data.references.length <= 15 && data.references.every(isAssetReference) &&
      (data.assetId === undefined || nonEmptyString(data.assetId)) &&
      hasOnlyKeys(data, ["prompt", "promptSource", "model", "resolution", "aspectRatio", "duration", "references", "assetId"]);
  }
  if (value.type !== "choice" || typeof value.data.title !== "string" || !Array.isArray(value.data.options) || value.data.options.length < 1) return false;
  const optionIds = new Set<string>();
  const validOptions = value.data.options.every((option) => {
    if (!isRecord(option) || !hasOnlyKeys(option, ["id", "label", "condition", "actions"]) || !nonEmptyString(option.id) || optionIds.has(option.id) || typeof option.label !== "string") return false;
    if (option.condition !== undefined && !isCondition(option.condition, variables)) return false;
    if (option.actions !== undefined && (!Array.isArray(option.actions) || !option.actions.every((action) => isAction(action, variables)))) return false;
    optionIds.add(option.id);
    return true;
  });
  const presentation = value.data.presentation as StoryNodePresentation;
  if (!validOptions || !hasOnlyKeys(value.data, ["title", "options", "timeout", "presentation"]) ||
    (presentation.media.mode === "own" && presentation.media.items.length > 1)) return false;
  if (value.data.timeout === undefined) return true;
  const timeout = value.data.timeout;
  return isRecord(timeout) && hasOnlyKeys(timeout, ["durationMs", "defaultOptionId"]) && typeof timeout.durationMs === "number" && Number.isInteger(timeout.durationMs) &&
    timeout.durationMs >= 1_000 && timeout.durationMs <= 300_000 && nonEmptyString(timeout.defaultOptionId) && optionIds.has(timeout.defaultOptionId);
}

function isEditorLayout(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.nodes) || !isRecord(value.viewport) ||
    (value.view !== "canvas" && value.view !== "code") || !isCoordinates(value.viewport) ||
    typeof value.viewport.zoom !== "number" || !Number.isFinite(value.viewport.zoom) || value.viewport.zoom <= 0 ||
    !hasOnlyKeys(value, ["version", "nodes", "viewport", "view"]) ||
    !hasOnlyKeys(value.viewport, ["x", "y", "zoom"])) return false;
  return Object.values(value.nodes).every(isPosition);
}

function isSourceFiles(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ["html", "css", "javascript"]) &&
    [value.html, value.css, value.javascript].every((candidate) => typeof candidate === "string" && isWorkspaceSourcePath(candidate));
}

function isWorkspaceSourcePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

function isInteractionOutcomes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && new Set(value).size === value.length &&
    value.every((outcome) => nonEmptyString(outcome) && outcome.length <= 80);
}

function isInteractionTimeout(value: unknown, outcomes: readonly string[]): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["durationMs", "outcome"]) &&
    typeof value.durationMs === "number" && Number.isInteger(value.durationMs) && value.durationMs >= 1_000 && value.durationMs <= 300_000 &&
    nonEmptyString(value.outcome) && outcomes.includes(value.outcome);
}

function isSurfaceFiles(value: unknown): value is StorySurfaceFiles {
  return isRecord(value) && hasOnlyKeys(value, ["html", "css", "javascript"]) && typeof value.html === "string" && value.html.length <= 20_000 &&
    typeof value.css === "string" && value.css.length <= 30_000 &&
    typeof value.javascript === "string" && value.javascript.length <= 20_000;
}

function isVariables(value: unknown): value is StoryVariable[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.every((candidate) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["id", "name", "type", "initialValue"]) || !nonEmptyString(candidate.id) || ids.has(candidate.id) || !nonEmptyString(candidate.name) || candidate.name.length > 80 || names.has(candidate.name)) return false;
    if (!variableValueMatches(candidate.type, candidate.initialValue)) return false;
    ids.add(candidate.id);
    names.add(candidate.name);
    return true;
  });
}

function isPlayerConfig(value: unknown): value is StoryPlayerConfig {
  if (!isRecord(value) || typeof value.title !== "string" || value.title.length > 120 ||
    !hasOnlyKeys(value, ["title", "viewport", "theme", "videoFit", "choicePosition"]) ||
    !isRecord(value.viewport) || !isViewportDimension(value.viewport.width) || !isViewportDimension(value.viewport.height) ||
    !hasOnlyKeys(value.viewport, ["width", "height"]) ||
    (value.videoFit !== "contain" && value.videoFit !== "cover") ||
    (value.choicePosition !== "center" && value.choicePosition !== "bottom") || !isRecord(value.theme) ||
    !hasOnlyKeys(value.theme, ["accentColor", "textColor", "font"])) return false;
  return /^#[0-9a-f]{6}$/i.test(String(value.theme.accentColor)) &&
    /^#[0-9a-f]{6}$/i.test(String(value.theme.textColor)) &&
    (value.theme.font === "sans" || value.theme.font === "serif");
}

function isViewportDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 240 && value <= 8192;
}

function isOpenUiContent(value: unknown): value is StoryOpenUiContent {
  if (!isRecord(value) || !hasOnlyKeys(value, ["title", "buttons"]) || typeof value.title !== "string" || value.title.length > 120 || !Array.isArray(value.buttons)) return false;
  const ids = new Set<string>();
  return value.buttons.length <= 8 && value.buttons.some((button) => isRecord(button) && button.action === "enter-game") && value.buttons.every((button) => isRecord(button) && hasOnlyKeys(button, ["id", "label", "action"]) && nonEmptyString(button.id) && !ids.has(button.id) && typeof button.label === "string" && button.label.length <= 80 && isOpenUiAction(button.action) && Boolean(ids.add(button.id)));
}

function isOpenUiAction(value: unknown): value is StoryOpenUiAction {
  return value === "enter-game";
}

function isCondition(value: unknown, variables: ReadonlyMap<string, StoryVariable>): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["variableId", "operator", "value"]) || !nonEmptyString(value.variableId) || !["equals", "not-equals", "greater-than", "greater-than-or-equal", "less-than", "less-than-or-equal"].includes(String(value.operator))) return false;
  const variable = variables.get(value.variableId);
  return Boolean(variable && variableValueMatches(variable.type, value.value) &&
    (variable.type === "number" || value.operator === "equals" || value.operator === "not-equals"));
}

export function normalizeStoryCondition(condition: StoryVariableCondition, variable?: StoryVariable): StoryVariableCondition | undefined {
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

function isAction(value: unknown, variables: ReadonlyMap<string, StoryVariable>): boolean {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.variableId)) return false;
  const variable = variables.get(value.variableId);
  if (!variable) return false;
  if (value.type !== "update-variable" || !hasOnlyKeys(value, ["type", "variableId", "operator", "value"]) ||
    !["set", "add", "subtract", "multiply", "divide"].includes(String(value.operator))) return false;
  return value.operator === "set"
    ? variableValueMatches(variable.type, value.value)
    : variable.type === "number" && typeof value.value === "number" && Number.isFinite(value.value) &&
      (value.operator !== "divide" || value.value !== 0);
}

function variableValueMatches(type: unknown, value: unknown): boolean {
  return type === "boolean" ? typeof value === "boolean" : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "text" && typeof value === "string";
}

function validSavedScenePlayback(node: Extract<StoryNode, { type: "scene" }>, value: unknown): value is ScenePlaybackState {
  if (!isRecord(value) || !nonEmptyString(value.mediaId) || !Number.isInteger(value.timeMs) || Number(value.timeMs) < 0 || Object.keys(value).some((key) => key !== "mediaId" && key !== "timeMs")) return false;
  const media = node.data.presentation.media;
  return media.mode === "own" && media.items.some((item) => item.id === value.mediaId);
}

function validPresentationMediaState(chapter: StoryChapter, value: unknown): value is PresentationMediaState | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["nodeId", "mediaId"]) || !nonEmptyString(value.nodeId) || !nonEmptyString(value.mediaId)) return false;
  const owner = chapter.nodes.find((node) => node.id === value.nodeId);
  return Boolean(owner && isPresentationNode(owner) && owner.data.presentation.media.mode === "own" &&
    owner.data.presentation.media.items.some((item) => item.id === value.mediaId));
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
    progress: state.progress ? { ...state.progress, visitedNodeIds: [...state.progress.visitedNodeIds], selectedOptionIds: [...state.progress.selectedOptionIds], unlockedEndingIds: [...state.progress.unlockedEndingIds] } : undefined,
    ...(state.presentationMedia ? { presentationMedia: { ...state.presentationMedia } } : {}),
    ...(state.scenePlayback ? { scenePlayback: { ...state.scenePlayback } } : {}),
  };
}

function addStoryProgress(progress: StoryProgressFacts | undefined, addition: { nodeId?: string; optionId?: string; endingId?: string }): StoryProgressFacts {
  const current = progress ?? { visitedNodeIds: [], selectedOptionIds: [], unlockedEndingIds: [] };
  return {
    currentNodeId: addition.nodeId ?? current.currentNodeId,
    visitedNodeIds: uniqueAppend(current.visitedNodeIds, addition.nodeId),
    selectedOptionIds: uniqueAppend(current.selectedOptionIds, addition.optionId),
    unlockedEndingIds: uniqueAppend(current.unlockedEndingIds, addition.endingId),
  };
}

function uniqueAppend(values: readonly string[], value: string | undefined): string[] {
  return value && !values.includes(value) ? [...values, value] : [...values];
}

function progressFromCurrentNode(nodeId: unknown, chapter: StoryChapter): StoryProgressFacts {
  const node = typeof nodeId === "string" ? chapter.nodes.find((candidate) => candidate.id === nodeId) : undefined;
  return { currentNodeId: node?.id, visitedNodeIds: node ? [node.id] : [], selectedOptionIds: [], unlockedEndingIds: node?.type === "ending" ? [node.id] : [] };
}

function validStoryProgressFacts(value: unknown, chapter: StoryChapter): StoryProgressFacts | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["currentNodeId", "visitedNodeIds", "selectedOptionIds", "unlockedEndingIds"]) || !Array.isArray(value.visitedNodeIds) || !Array.isArray(value.selectedOptionIds) || !Array.isArray(value.unlockedEndingIds)) return undefined;
  if (!uniqueStrings(value.visitedNodeIds) || !uniqueStrings(value.selectedOptionIds) || !uniqueStrings(value.unlockedEndingIds)) return undefined;
  const nodeIds = new Set(chapter.nodes.map((node) => node.id));
  const optionIds = new Set(chapter.nodes.flatMap((node) => node.type === "choice" ? node.data.options.map((option) => option.id) : []));
  const endingIds = new Set(chapter.nodes.filter((node) => node.type === "ending").map((node) => node.id));
  if (value.currentNodeId !== undefined && (typeof value.currentNodeId !== "string" || !nodeIds.has(value.currentNodeId))) return undefined;
  if (value.visitedNodeIds.some((id) => !nodeIds.has(id)) || value.selectedOptionIds.some((id) => !optionIds.has(id)) || value.unlockedEndingIds.some((id) => !endingIds.has(id))) return undefined;
  return { ...(typeof value.currentNodeId === "string" ? { currentNodeId: value.currentNodeId } : {}), visitedNodeIds: [...value.visitedNodeIds], selectedOptionIds: [...value.selectedOptionIds], unlockedEndingIds: [...value.unlockedEndingIds] };
}

function uniqueStrings(value: unknown[]): value is string[] {
  return value.every((item) => typeof item === "string") && new Set(value).size === value.length;
}

function sameRecord(left: Readonly<Record<string, StoryVariableValue>>, right: Readonly<Record<string, StoryVariableValue>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function isCoordinates(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y);
}

function isPosition(value: unknown): boolean {
  return isCoordinates(value) && hasOnlyKeys(value, ["x", "y"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isModelRef(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["provider", "id"]) && nonEmptyString(value.provider) && nonEmptyString(value.id);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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
