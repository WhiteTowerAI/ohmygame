import type { PlayableSeen } from "./playable-seen.js";

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

/**
 * Where the player has got to inside the current Node, in whatever JSON the
 * Node chooses, such as the line a script is on. It is kept with the save and
 * on the back stack, so Continue, loading a slot, and Back return there. A
 * Node entered through a Signal starts with none.
 */
export interface PlayablePositionService {
  get(): JsonValue | null;
  set(value: JsonValue | null): Promise<void>;
}

/**
 * Music plays on across Nodes until a Node changes it, and is kept with the
 * save. Asking for the music already playing leaves it playing. While a Node
 * plays a video or audio element with sound, the music turns down.
 */
export interface PlayableAudioService {
  /** Fades to the Asset, or out with null, over `fade` seconds (1 by default). */
  music(assetId: string | null, options?: { fade?: number }): void;
  /** Plays the Asset once over everything else. */
  sound(assetId: string): void;
}

/**
 * The player's settings, kept apart from saves: they outlast new games and
 * restarts. `musicVolume` and `soundVolume` (0 to 1) set the Runtime's
 * volumes, and sound covers videos as well; any other key is the project's.
 */
export interface PlayablePreferencesService {
  get(): Readonly<JsonObject>;
  /** Changes only the given keys. */
  set(values: JsonObject): Promise<void>;
}

/** A saved game the player put in a slot. */
export interface PlayableSlotSummary {
  id: string;
  savedAt: string;
  /** The Node the game continues in. */
  nodeId: string;
  /** What the Node said about the moment, such as the current line. */
  note?: string;
  /** Saved from another version of the game, so it cannot be loaded. */
  incompatible?: true;
}

export interface NodeRuntimeContext {
  root: ShadowRoot;
  assets: { url(id: string): string };
  state: PlayableStateService;
  position: PlayablePositionService;
  audio: PlayableAudioService;
  preferences: PlayablePreferencesService;
  session: {
    hasSave(): boolean;
    reset(): Promise<void>;
    continue(): Promise<void>;
    save(): Promise<void>;
    restart(): Promise<void>;
    /** Saved games in slots, by ID. */
    slots(): PlayableSlotSummary[];
    /** Saves the game in a slot, replacing what was there. */
    saveSlot(id: string, note?: string): Promise<void>;
    /** Continues the game saved in a slot. */
    loadSlot(id: string): Promise<void>;
    deleteSlot(id: string): Promise<void>;
  };
  /**
   * What the player has seen so far, across every game they started: when each
   * Node was first entered and each edge first taken. A `report` preview
   * gives every Node and edge, so a story map shows the author all of it.
   */
  story: { seen(): PlayableSeen };
  lifecycle: { signal: AbortSignal };
}

export interface PlayableNodeContext extends NodeRuntimeContext {
  story: NodeRuntimeContext["story"] & {
    /**
     * The player entered this Node before, earlier in this game or in another
     * one, so a Scene can offer to skip what they have seen. Always false in a
     * `report` preview.
     */
    seenBefore: boolean;
  };
  navigation: {
    emit(signal: string): Promise<void>;
    back(): Promise<void>;
    /** The Node declares the Signal and an edge routes it, so emitting it goes somewhere. */
    connected(signal: string): boolean;
  };
}

export type PlayableCleanup = () => void | Promise<void>;
export type PlayableMount = (
  context: PlayableNodeContext,
) => void | PlayableCleanup | Promise<void | PlayableCleanup>;
