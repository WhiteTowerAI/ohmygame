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
  /**
   * What the Exit is for. Absent, it moves the story on. `navigation` marks a
   * way around the game, such as a Home button shown on many Scenes; the
   * canvas names its target instead of drawing a line. Routing ignores it.
   */
  role?: "navigation";
  /**
   * One sentence saying when the Scene emits this Signal, such as "if trust
   * is 3 or more". The Agent writes it; the canvas shows it on the Exit row.
   * Display only: the Scene's code decides, and routing ignores it.
   */
  when?: string;
}

export interface PlayableNode {
  id: string;
  title: string;
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
  /**
   * One-line descriptions of `initialState` keys (Variables), written by the
   * Agent and shown read-only in Project → Variables. Display only.
   */
  variables?: Record<string, string>;
  assets: Record<string, PlayableAssetDefinition>;
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

export type PlayableCleanup = () => void | Promise<void>;
export type PlayableMount = (
  context: PlayableNodeContext,
) => void | PlayableCleanup | Promise<void | PlayableCleanup>;
