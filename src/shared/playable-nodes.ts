export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PlayableNavigationMode = "replace" | "push";
export type PlayableAssetType = "image" | "video" | "audio";

export interface PlayableSource {
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
  source: PlayableSource;
  assets: string[];
  signals: PlayableSignal[];
}

export interface PlayableShell {
  source: PlayableSource;
  assets: string[];
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

export interface PlayableGraph {
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
  destinations: Record<string, string>;
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

export interface PlayableRuntimeContext {
  root: Document;
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

export interface PlayableNodeContext extends PlayableRuntimeContext {
  navigation: {
    emit(signal: string): Promise<void>;
    back(): Promise<void>;
  };
}

export interface PlayableShellContext extends PlayableRuntimeContext {
  navigation: {
    back(): Promise<void>;
    open(destination: string, mode?: PlayableNavigationMode): Promise<void>;
  };
}

export type PlayableCleanup = () => void | Promise<void>;
export type PlayableMount = (
  context: PlayableNodeContext,
) => void | PlayableCleanup | Promise<void | PlayableCleanup>;
export type PlayableShellMount = (
  context: PlayableShellContext,
) => void | PlayableCleanup | Promise<void | PlayableCleanup>;
