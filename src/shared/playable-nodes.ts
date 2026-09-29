export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PlayableNavigationMode = "replace" | "push";
export type PlayableAssetType = "image" | "video" | "audio";

export interface NodeSource {
  html: string;
  css: string;
  javascript: string;
}

export type PlayableAssetSource =
  { kind: "library"; assetId: string } | { kind: "workspace"; path: string };

export interface PlayableAssetDefinition {
  type: PlayableAssetType;
  source: PlayableAssetSource;
}

export interface PlayableSignal {
  id: string;
  label: string;
}

export interface PlayableNode {
  id: string;
  title: string;
  source: NodeSource;
  assets: string[];
  signals: PlayableSignal[];
}

/** Edges from the Shell's Signals name this reserved ID as their source Node. */
export const PLAYABLE_SHELL_ID = "shell";

export interface PlayableShell {
  source: NodeSource;
  assets: string[];
  signals: PlayableSignal[];
}

export interface PlayableEdge {
  id: string;
  source: {
    nodeId: string;
    signal: string;
  };
  targetNodeId: string;
  mode: PlayableNavigationMode;
}

export interface NodeGraph {
  version: 1;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
  entryNodeId: string;
  initialState: JsonObject;
  assets: Record<string, PlayableAssetDefinition>;
  shell?: PlayableShell;
  nodes: PlayableNode[];
  edges: PlayableEdge[];
}

export interface PlayableStateService {
  get(): Readonly<JsonObject>;
  get(key: string): JsonValue;
  set(key: string, value: JsonValue): Promise<void>;
  patch(values: JsonObject): Promise<void>;
  subscribe(listener: (state: Readonly<JsonObject>) => void): () => void;
}

export interface NodeRuntimeContext {
  root: ShadowRoot;
  assets: { url(id: string): string };
  state: PlayableStateService;
  session: {
    hasSave(): boolean;
    reset(): Promise<void>;
    continue(): Promise<void>;
    save(): Promise<void>;
    restart(): Promise<void>;
  };
  lifecycle: { signal: AbortSignal };
}

export interface PlayableNodeContext extends NodeRuntimeContext {
  navigation: {
    emit(signal: string): Promise<void>;
    back(): Promise<void>;
  };
}

/** The Shell navigates like a Node: it emits its own Signals, which edges route. */
export type PlayableShellContext = PlayableNodeContext;

export type PlayableCleanup = () => void | Promise<void>;
export type PlayableMount = (
  context: PlayableNodeContext,
) => void | PlayableCleanup | Promise<void | PlayableCleanup>;
export type PlayableShellMount = (
  context: PlayableShellContext,
) => void | PlayableCleanup | Promise<void | PlayableCleanup>;
