import { IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_MODEL, VIDEO_RESOLUTIONS, type StoryAction, type StoryAssetReference, type StoryChapter, type StoryChoiceOption, type StoryDocument, type StoryEdge, type StoryNode, type StoryVariable, type StoryVariableCondition, type StoryVariableValue } from "./contracts.js";

const STORY_NODE_TYPES = new Set(["start", "scene", "choice", "ending", "text", "image", "video", "asset"]);

export function createStoryDocument(): StoryDocument {
  return {
    version: 4,
    variables: [],
    chapters: [{
      id: crypto.randomUUID(),
      title: "Untitled",
      nodes: [{ id: crypto.randomUUID(), type: "start", position: { x: 80, y: 180 }, data: {} }],
      edges: [],
    }],
  };
}

export function isStoryDocument(value: unknown): value is StoryDocument {
  if (!isRecord(value) || value.version !== 4 || !Array.isArray(value.chapters) || value.chapters.length === 0) return false;
  if (value.variables !== undefined && !isVariables(value.variables)) return false;
  const variables = new Map((value.variables ?? []).map((variable) => [variable.id, variable]));
  const chapterIds = new Set<string>();
  return value.chapters.every((chapter) => {
    if (!isRecord(chapter) || !nonEmptyString(chapter.id) || chapterIds.has(chapter.id) || typeof chapter.title !== "string" ||
      !Array.isArray(chapter.nodes) || !Array.isArray(chapter.edges)) return false;
    chapterIds.add(chapter.id);
    const nodes = chapter.nodes as unknown[];
    const nodeIds = new Set<string>();
    const nodeById = new Map<string, StoryNode>();
    for (const node of nodes) {
      if (!isStoryNode(node, variables) || nodeIds.has(node.id)) return false;
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
      if (source.type === "choice" ? !source.data.options.some((option) => option.id === handle) : handle !== "out") return false;
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
  const next = { ...values };
  for (const action of actions ?? []) {
    if (action.type === "set-variable") next[action.variableId] = action.value;
    else {
      const current = next[action.variableId];
      if (typeof current !== "number") throw new Error(`Cannot increment non-number variable: ${action.variableId}`);
      const incremented = current + action.amount;
      if (!Number.isFinite(incremented)) throw new Error(`Variable increment is not finite: ${action.variableId}`);
      next[action.variableId] = incremented;
    }
  }
  return next;
}

export function resolveStoryChoice(chapter: StoryChapter, state: StoryRuntimeState, optionId: string): StoryRuntimeState {
  if (state.chapterId !== chapter.id) throw new Error("Runtime state belongs to a different chapter");
  const node = chapter.nodes.find((candidate) => candidate.id === state.nodeId);
  if (node?.type !== "choice") throw new Error("The current story node is not a choice");
  const option = node.data.options.find((candidate) => candidate.id === optionId);
  if (!option || !matchesStoryCondition(option.condition, state.variables)) throw new Error("The selected choice is not available");
  const next = getNextNode(chapter, node.id, option.id);
  if (!next) throw new Error("The selected choice is not connected");
  return { ...state, nodeId: next.id, variables: applyStoryActions(option.actions, state.variables) };
}

export function countStoryVariableReferences(options: readonly StoryChoiceOption[], variableId: string): number {
  return options.reduce((count, option) => count + Number(option.condition?.variableId === variableId) + (option.actions ?? []).filter((action) => action.variableId === variableId).length, 0);
}

export function removeStoryVariableReferences(options: readonly StoryChoiceOption[], variableId: string): StoryChoiceOption[] {
  return options.map((option) => {
    const actions = option.actions?.filter((action) => action.variableId !== variableId);
    return {
      ...option,
      ...(option.condition?.variableId === variableId ? { condition: undefined } : {}),
      ...(actions?.length ? { actions } : { actions: undefined }),
    };
  });
}

export function normalizeStoryVariableReferences(options: readonly StoryChoiceOption[], variables: ReadonlyMap<string, StoryVariable>): StoryChoiceOption[] {
  return options.map((option) => {
    const actions = option.actions?.reduce<StoryAction[]>((normalized, action) => {
      const variable = variables.get(action.variableId);
      if (!variable || (action.type === "increment-variable" && variable.type !== "number")) return normalized;
      normalized.push(action.type === "set-variable"
        ? { ...action, value: variableValue(action.value, variable.type) }
        : { ...action, amount: Number.isFinite(action.amount) ? action.amount : 0 });
      return normalized;
    }, []);
    return {
      ...option,
      ...(option.condition ? { condition: normalizeCondition(option.condition, variables.get(option.condition.variableId)) } : {}),
      ...(actions?.length ? { actions } : { actions: undefined }),
    };
  });
}

export function parseStoryDocument(value: unknown): StoryDocument {
  const migrated = migrateStoryDocument(value);
  if (!isStoryDocument(migrated)) throw new Error("Invalid story document");
  return migrated;
}

function migrateStoryDocument(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 3 || !Array.isArray(value.chapters)) return value;
  return {
    ...value,
    version: 4,
    chapters: value.chapters.map((chapter) => !isRecord(chapter) || !Array.isArray(chapter.nodes) ? chapter : ({
      ...chapter,
      nodes: chapter.nodes.map(migrateStoryNode),
    })),
  };
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

export function validatePlayableChapter(chapter: StoryChapter, availableAssetIds?: ReadonlySet<string>): StoryPlayIssue | undefined {
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
    if (node.type === "scene" && availableAssetIds) {
      const missing = node.data.clips.find((clip) => {
        const assetId = resolveStoryVideoClipAssetId(chapter, clip);
        return !assetId || !availableAssetIds.has(assetId);
      });
      if (missing) return { nodeId: node.id, message: "A video used by this scene is missing from Library." };
    }
    const handles = node.type === "choice" ? node.data.options.map((option) => option.id) : ["out"];
    for (const handle of handles) {
      const edge = getOutgoingEdge(chapter, node.id, handle);
      if (!edge) return {
        nodeId: node.id,
        message: node.type === "choice"
          ? `Connect the choice "${node.data.options.find((option) => option.id === handle)?.label || "Untitled option"}".`
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
    !STORY_NODE_TYPES.has(value.type) || !isPosition(value.position) || !isRecord(value.data)) return false;
  if (value.type === "start") return Object.keys(value.data).length === 0;
  if (value.type === "scene") {
    if (typeof value.data.title !== "string") return false;
    if (!Array.isArray(value.data.clips)) return false;
    const clipIds = new Set<string>();
    return value.data.clips.every((clip) => {
      if (!isRecord(clip) || !nonEmptyString(clip.id) || clipIds.has(clip.id) || !isAssetReference(clip.source)) return false;
      clipIds.add(clip.id);
      return true;
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
    if (option.actions !== undefined && (!Array.isArray(option.actions) || !option.actions.every((action) => isAction(action, variables)))) return false;
    optionIds.add(option.id);
    return true;
  });
  if (!validOptions) return false;
  if (value.data.timeout === undefined) return true;
  const timeout = value.data.timeout;
  return isRecord(timeout) && typeof timeout.durationMs === "number" && Number.isInteger(timeout.durationMs) &&
    timeout.durationMs >= 1_000 && timeout.durationMs <= 300_000 && nonEmptyString(timeout.defaultOptionId) && optionIds.has(timeout.defaultOptionId);
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

function isAction(value: unknown, variables: ReadonlyMap<string, StoryVariable>): boolean {
  if (!isRecord(value) || !nonEmptyString(value.variableId)) return false;
  const variable = variables.get(value.variableId);
  if (!variable) return false;
  if (value.type === "set-variable") return variableValueMatches(variable.type, value.value);
  return value.type === "increment-variable" && variable.type === "number" && typeof value.amount === "number" && Number.isFinite(value.amount);
}

function variableValueMatches(type: unknown, value: unknown): boolean {
  return type === "boolean" ? typeof value === "boolean" : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "text" && typeof value === "string";
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
