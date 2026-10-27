import type {
  CompiledNodeGraph,
  CompiledPlayableSurface,
} from "./playable-compiled.js";
import {
  playableEdgeForSignal,
  playableNodeById,
} from "./playable-graph.js";
import {
  createPlayableNavigation,
  navigatePlayableBack,
  navigatePlayableSignal,
  PlayableNavigationError,
  type PlayableNavigationState,
} from "./playable-navigation.js";
import {
  type JsonObject,
  type JsonValue,
  type PlayableCleanup,
  type NodeGraph,
  type PlayableNavigationMode,
  type PlayableNodeContext,
  type NodeRuntimeContext,
  type PlayableSlotSummary,
  type PlayableStateService,
} from "./playable-nodes.js";
import {
  emptyPlayableSeen,
  layoutPlayableStory,
  parsePlayableSeen,
  playableStoryMap,
  type PlayableSeen,
  type PlayableStoryLayout,
} from "./playable-story-map.js";
import {
  cloneJsonObject,
  createPlayableState,
  isJsonObject,
  patchPlayableState,
  PlayableStateError,
  setPlayableState,
} from "./playable-state.js";

export interface PlayableSave {
  version: 1;
  graphVersion: 1;
  graphSignature: string;
  savedAt: string;
  currentNodeId: string;
  backStack: string[];
  state: JsonObject;
  /** The current Node's position; saves without one start the Node from its beginning. */
  position?: JsonValue;
  /** A position for each back stack entry, in the same order; null where there is none. */
  backPositions?: (JsonValue | null)[];
  /** The Asset ID of the music playing. */
  music?: string;
}

export interface PlayableSaveStore {
  load(): Promise<unknown | undefined>;
  save(save: PlayableSave): Promise<void>;
}

/** A game the player saved in a slot. */
export interface PlayableSlot {
  save: PlayableSave;
  note?: string;
}

/**
 * Where save slots are kept, all together and beside the save. A write
 * replaces every slot, and slots from another version of the game are
 * written back as they were read.
 */
export interface PlayableSlotStore {
  load(): Promise<unknown | undefined>;
  save(slots: Record<string, unknown>): Promise<void>;
}

/** Where the player's settings are kept; losing them never stops the game. */
export interface PlayablePreferencesStore {
  load(): Promise<unknown | undefined>;
  save(preferences: JsonObject): Promise<void>;
}

/**
 * Plays the Runtime's music and sounds. Hosts without sound, such as tests
 * and thumbnail captures, leave it out.
 */
export interface PlayableAudioHost {
  /** Fades to the music at `url`, or out when it is undefined. */
  music(url: string | undefined, fadeSeconds: number): void;
  sound(url: string): void;
  volumes(volumes: { music: number; sound: number }): void;
}

/** Volumes before the player changes them. */
export const PLAYABLE_DEFAULT_PREFERENCES = { musicVolume: 0.7, soundVolume: 1 } as const;

/** Where the Runtime keeps what the player has seen; apart from the save slot. */
export interface PlayableSeenStore {
  load(): Promise<unknown | undefined>;
  save(seen: PlayableSeen): Promise<void>;
}

export interface PlayableMountedSurface {
  /** Stops interaction and media while retaining the outgoing picture. */
  deactivate?(): void;
  /** Enables a prepared surface after the outgoing cleanup has settled. */
  activate?(): void;
  cleanup?: PlayableCleanup;
  destroy(): void | Promise<void>;
}

export interface PlayableSurfaceHost {
  mountNode(
    surface: CompiledPlayableSurface,
    context: Omit<PlayableNodeContext, "root">,
  ): Promise<PlayableMountedSurface>;
}

/**
 * `follow` navigates on Signals (Playtest and Published Player). `report`
 * validates navigation requests and reports where they would lead while the
 * current Node stays mounted (Workbench preview).
 */
export type NodeRuntimePolicy = "follow" | "report";

export interface NodeRuntimeOptions {
  graph: NodeGraph;
  compiled: CompiledNodeGraph;
  graphSignature: string;
  surfaceHost: PlayableSurfaceHost;
  saveStore: PlayableSaveStore;
  /** Defaults to memory, so nothing seen outlasts the session. */
  seenStore?: PlayableSeenStore;
  /** Defaults to memory. */
  slotStore?: PlayableSlotStore;
  /** Defaults to memory. */
  preferencesStore?: PlayablePreferencesStore;
  /** Defaults to silence. */
  audio?: PlayableAudioHost;
  assetUrls: Readonly<Record<string, string>>;
  policy?: NodeRuntimePolicy;
  /** Node to enter instead of `entryNodeId`. */
  startNodeId?: string;
  /** Overrides applied to `initialState` for this session; keys must be declared. */
  previewState?: JsonObject;
  now?: () => Date;
  onError?: (error: unknown) => void;
  /** Called whenever the diagnostics snapshot may have changed. */
  onChange?: () => void;
}

export type NodeRuntimeStatus =
  | "idle"
  | "starting"
  | "running"
  | "transitioning"
  | "failed"
  | "disposed";

export interface NodeRuntimeSignalRecord {
  nodeId: string;
  signal: string;
  edgeId?: string;
  targetNodeId?: string;
  at: string;
}

/** A navigation request that the `report` policy validated but did not follow. */
export type NodeRuntimeNavigationReport =
  | {
      kind: "signal";
      nodeId: string;
      signal: string;
      edgeId?: string;
      targetNodeId?: string;
      mode?: PlayableNavigationMode;
      at: string;
    }
  | { kind: "back"; nodeId: string; targetNodeId?: string; at: string }
  | { kind: "restart" | "continue"; targetNodeId: string; at: string };

export interface NodeRuntimeErrorRecord {
  /** Absent for Runtime-level errors. */
  nodeId?: string;
  code: string;
  message: string;
  at: string;
}

export interface NodeRuntimeStateAccess {
  /** Keys read; `"*"` when the whole State was read or subscribed to. */
  read: string[];
  wrote: string[];
}

export interface NodeRuntimeSnapshot {
  status: NodeRuntimeStatus;
  policy: NodeRuntimePolicy;
  currentNodeId: string;
  backStack: string[];
  state: JsonObject;
  recentSignals: NodeRuntimeSignalRecord[];
  reports: NodeRuntimeNavigationReport[];
  stateAccess: Record<string, NodeRuntimeStateAccess>;
  errors: NodeRuntimeErrorRecord[];
  /** `incompatible` when a save exists but belongs to another version of the graph. */
  save: { present: boolean; savedAt?: string; incompatible?: true };
  /** The current Node's position. */
  position: JsonValue | null;
  /** The Asset ID of the music playing. */
  music?: string;
}

const HISTORY_LIMIT = 20;
const MAX_POSITION_BYTES = 64 * 1024;
const MAX_PREFERENCES_BYTES = 64 * 1024;
const MAX_SLOTS = 100;
const MAX_SLOT_NOTE = 200;
const SLOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const DEFAULT_MUSIC_FADE = 1;

/** The positions that go with a navigation state. */
interface PlayablePositions {
  current: JsonValue | null;
  back: (JsonValue | null)[];
}

const NO_POSITIONS: PlayablePositions = { current: null, back: [] };

export type NodeRuntimeErrorCode =
  | "not-started"
  | "already-started"
  | "disposed"
  | "runtime-failed"
  | "navigation-in-progress"
  | "stale-surface"
  | "missing-compiled-surface"
  | "missing-asset-url"
  | "undeclared-asset"
  | "no-save"
  | "invalid-cleanup"
  | "invalid-position"
  | "invalid-preferences"
  | "invalid-slot";

export class NodeRuntimeError extends Error {
  constructor(
    readonly code: NodeRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeRuntimeError";
  }
}

interface ActiveSurface {
  token: SurfaceToken;
  abortController: AbortController;
  mounted: PlayableMountedSurface;
}

interface SurfaceToken {
  /** Node ID. */
  surfaceId: string;
  active: boolean;
  navigationReady: boolean;
}

export class NodeRuntime {
  readonly #graph: NodeGraph;
  readonly #compiled: CompiledNodeGraph;
  readonly #graphSignature: string;
  readonly #surfaceHost: PlayableSurfaceHost;
  readonly #saveStore: PlayableSaveStore;
  readonly #seenStore: PlayableSeenStore;
  readonly #slotStore: PlayableSlotStore;
  readonly #preferencesStore: PlayablePreferencesStore;
  readonly #audio?: PlayableAudioHost;
  #incompatibleSave = false;
  readonly #assetUrls: Readonly<Record<string, string>>;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #onChange: () => void;
  readonly #policy: NodeRuntimePolicy;
  readonly #stateListeners = new Set<(state: Readonly<JsonObject>) => void>();
  readonly #stateAccess = new Map<string, { read: Set<string>; wrote: Set<string> }>();
  readonly #recordedErrors = new WeakSet<object>();

  #navigation: PlayableNavigationState;
  #state: JsonObject;
  #recentSignals: NodeRuntimeSignalRecord[] = [];
  #reports: NodeRuntimeNavigationReport[] = [];
  #errors: NodeRuntimeErrorRecord[] = [];
  #cachedSave?: PlayableSave;
  #activeNode?: ActiveSurface;
  /**
   * Back stack depth at which the player left the story by a navigation
   * Signal. While set, the save keeps where they left it.
   */
  #leftStoryAt?: number;
  #started = false;
  #starting = false;
  #disposed = false;
  #mountingAbortController?: AbortController;
  #failed = false;
  #transitioning = false;
  #activeOperation?: Promise<void>;
  #disposePromise?: Promise<void>;
  #saveQueue: Promise<void> = Promise.resolve();
  #seen: PlayableSeen = emptyPlayableSeen();
  #seenQueue: Promise<void> = Promise.resolve();
  #seenSaveFailed = false;
  #storyLayout?: PlayableStoryLayout;
  #positions: PlayablePositions = NO_POSITIONS;
  #music?: string;
  /** Slots as stored, including ones this version cannot load. */
  #slots: Record<string, unknown> = {};
  #slotQueue: Promise<void> = Promise.resolve();
  #preferences: JsonObject = {};
  #preferencesQueue: Promise<void> = Promise.resolve();
  #preferencesSaveFailed = false;

  constructor(options: NodeRuntimeOptions) {
    this.#graph = options.graph;
    this.#compiled = options.compiled;
    this.#graphSignature = options.graphSignature;
    this.#surfaceHost = options.surfaceHost;
    this.#saveStore = options.saveStore;
    this.#seenStore = options.seenStore ?? new MemoryPlayableSeenStore();
    this.#slotStore = options.slotStore ?? new MemoryPlayableSlotStore();
    this.#preferencesStore = options.preferencesStore ?? new MemoryPlayablePreferencesStore();
    this.#audio = options.audio;
    this.#assetUrls = options.assetUrls;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
    this.#onChange = options.onChange ?? (() => undefined);
    this.#policy = options.policy ?? "follow";
    this.#navigation = createPlayableNavigation(options.graph);
    if (options.startNodeId !== undefined) {
      if (!playableNodeById(options.graph, options.startNodeId))
        throw new PlayableNavigationError(
          "unknown-node",
          `Start Node "${options.startNodeId}" does not exist.`,
        );
      this.#navigation = { currentNodeId: options.startNodeId, backStack: [] };
    }
    this.#state = options.previewState
      ? patchPlayableState(
          options.graph.initialState,
          options.graph.initialState,
          options.previewState,
        )
      : createPlayableState(options.graph.initialState);
  }

  async start(): Promise<void> {
    this.#assertNotDisposed();
    this.#assertNotFailed();
    if (this.#started || this.#starting)
      throw new NodeRuntimeError(
        "already-started",
        "Node Runtime has already started.",
      );
    this.#starting = true;
    this.#changed();
    const operation = this.#performStart();
    this.#activeOperation = operation;
    try {
      await operation;
    } catch (cause) {
      this.#recordError(cause, this.#navigation.currentNodeId);
      throw cause;
    } finally {
      this.#starting = false;
      if (this.#activeOperation === operation)
        this.#activeOperation = undefined;
      this.#changed();
    }
  }

  async #performStart(): Promise<void> {
    try {
      const stored = await this.#saveStore.load();
      this.#cachedSave = this.#parseSave(stored);
      this.#incompatibleSave = stored !== undefined && stored !== null && !this.#cachedSave;
      // What the player has seen only feeds the Story Map; losing it never stops the game.
      this.#seen = parsePlayableSeen(await this.#seenStore.load().catch((cause: unknown) => this.#reportError(cause)));
      // Slots that cannot be read are kept out of the way, never lost by a later write.
      const slots = await this.#slotStore.load().catch((cause: unknown) => this.#reportError(cause));
      this.#slots = isRecord(slots) ? { ...slots } : {};
      // Settings that cannot be read start over, like what the player has seen.
      this.#preferences = parsePreferences(await this.#preferencesStore.load().catch((cause: unknown) => this.#reportError(cause)));
      this.#applyVolumes();
      this.#assertNotDisposed();
      this.#started = true;
      this.#activeNode = await this.#mountNode(this.#navigation.currentNodeId);
      this.#assertNotDisposed();
      this.#activeNode.token.navigationReady = true;
      this.#activeNode.mounted.activate?.();
      this.#see("nodes", this.#navigation.currentNodeId);
    } catch (cause) {
      if (!this.#disposed) this.#failed = true;
      await this.#disposeActiveSurface(this.#activeNode);
        this.#activeNode = undefined;
        this.#started = false;
      throw cause;
    }
  }

  snapshot(): NodeRuntimeSnapshot {
    return {
      status: this.#status(),
      policy: this.#policy,
      currentNodeId: this.#navigation.currentNodeId,
      backStack: [...this.#navigation.backStack],
      state: cloneJsonObject(this.#state),
      recentSignals: this.#recentSignals.map((entry) => ({ ...entry })),
      reports: this.#reports.map((entry) => ({ ...entry })),
      stateAccess: Object.fromEntries(
        [...this.#stateAccess].map(([surfaceId, access]) => [
          surfaceId,
          { read: [...access.read].sort(), wrote: [...access.wrote].sort() },
        ]),
      ),
      errors: this.#errors.map((entry) => ({ ...entry })),
      save: this.#cachedSave
        ? { present: true, savedAt: this.#cachedSave.savedAt }
        : { present: false, ...(this.#incompatibleSave ? { incompatible: true as const } : {}) },
      position: structuredClone(this.#positions.current),
      ...(this.#music ? { music: this.#music } : {}),
    };
  }

  /**
   * Records an error raised by surface code outside a Runtime call, such as
   * an exception in an event handler. Errors already recorded are ignored.
   */
  recordError(error: unknown, nodeId = this.#navigation.currentNodeId): void {
    this.#recordError(error, nodeId);
  }

  #status(): NodeRuntimeStatus {
    if (this.#disposed) return "disposed";
    if (this.#failed) return "failed";
    if (this.#starting) return "starting";
    if (this.#transitioning) return "transitioning";
    return this.#started ? "running" : "idle";
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#mountingAbortController?.abort();
    this.#started = false;
    this.#changed();
    const activeOperation = this.#activeOperation;
    this.#disposePromise = this.#performDispose(activeOperation);
    return this.#disposePromise;
  }

  async #performDispose(
    activeOperation: Promise<void> | undefined,
  ): Promise<void> {
    try {
      await activeOperation;
    } catch {
      // The operation's caller receives its original error.
    }
    try {
      await this.#saveQueue;
    } catch {
      // The state or navigation caller receives the storage error.
    }
    await this.#seenQueue;
    await this.#disposeActiveSurface(this.#activeNode);
    this.#activeNode = undefined;
    this.#stateListeners.clear();
  }

  async #emit(token: SurfaceToken, signal: string): Promise<void> {
    this.#assertNavigationReady(token);
    const nodeId = this.#navigation.currentNodeId;
    const node = playableNodeById(this.#graph, nodeId);
    const declared = node?.signals.find((candidate) => candidate.id === signal);
    if (!declared) {
      throw new PlayableNavigationError(
        "unknown-signal",
        `Node "${nodeId}" did not declare Signal "${signal}".`,
      );
    }
    const edge = playableEdgeForSignal(this.#graph, nodeId, signal);
    const at = this.#now().toISOString();
    this.#recentSignals = [
      ...this.#recentSignals,
      {
        nodeId,
        signal,
        ...(edge ? { edgeId: edge.id, targetNodeId: edge.targetNodeId } : {}),
        at,
      },
    ].slice(-HISTORY_LIMIT);
    if (this.#policy === "report") {
      this.#report({
        kind: "signal",
        nodeId,
        signal,
        ...(edge
          ? { edgeId: edge.id, targetNodeId: edge.targetNodeId, mode: edge.mode }
          : {}),
        at,
      });
      return;
    }
    this.#changed();
    if (edge) this.#see("edges", edge.id);
    // A navigation Signal leads around the game, not on through the story.
    const leftStoryAt =
      declared.role === "navigation"
        ? (this.#leftStoryAt ?? this.#navigation.backStack.length)
        : undefined;
    // A Node entered by a Signal starts afresh; Allow Back keeps where this one was.
    const positions: PlayablePositions = {
      current: null,
      back: edge?.mode === "push"
        ? [...this.#positions.back, this.#positions.current]
        : [...this.#positions.back],
    };
    await this.#navigate(
      () => navigatePlayableSignal(this.#graph, this.#navigation, signal),
      () => { this.#positions = positions; },
      leftStoryAt,
    );
  }

  async #back(token: SurfaceToken): Promise<void> {
    this.#assertNavigationReady(token);
    if (this.#policy === "report") {
      const targetNodeId = this.#navigation.backStack.at(-1);
      this.#report({
        kind: "back",
        nodeId: this.#navigation.currentNodeId,
        ...(targetNodeId ? { targetNodeId } : {}),
        at: this.#now().toISOString(),
      });
      return;
    }
    // Back as far as where the player left the story is still around the game.
    const leftStoryAt =
      this.#leftStoryAt !== undefined &&
      this.#navigation.backStack.length > this.#leftStoryAt
        ? this.#leftStoryAt
        : undefined;
    const positions: PlayablePositions = {
      current: this.#positions.back.at(-1) ?? null,
      back: this.#positions.back.slice(0, -1),
    };
    await this.#navigate(
      () => navigatePlayableBack(this.#navigation),
      () => { this.#positions = positions; },
      leftStoryAt,
    );
  }

  #report(report: NodeRuntimeNavigationReport): void {
    this.#reports = [...this.#reports, report].slice(-HISTORY_LIMIT);
    this.#changed();
  }

  async #navigate(
    resolve: () => PlayableNavigationState,
    prepare?: () => void,
    leftStoryAt?: number,
  ): Promise<void> {
    this.#assertStarted();
    if (this.#transitioning)
      throw new NodeRuntimeError(
        "navigation-in-progress",
        "A Playable navigation is already in progress.",
      );
    const next = resolve();
    this.#transitioning = true;
    this.#changed();
    const operation = this.#performNavigation(next, prepare, leftStoryAt);
    this.#activeOperation = operation;
    try {
      await operation;
    } finally {
      this.#transitioning = false;
      if (this.#activeOperation === operation)
        this.#activeOperation = undefined;
      this.#changed();
    }
  }

  async #performNavigation(
    next: PlayableNavigationState,
    prepare: (() => void) | undefined,
    leftStoryAt: number | undefined,
  ): Promise<void> {
    try {
      prepare?.();
      const previous = this.#activeNode;
      this.#activeNode = undefined;
      this.#deactivateSurface(previous);
      try {
        this.#navigation = next;
        this.#activeNode = await this.#mountNode(next.currentNodeId);
        this.#assertNotDisposed();
      } finally {
        // Keep the outgoing picture until the incoming surface is ready, even
        // though its context and input have already been disabled.
        await this.#disposeActiveSurface(previous);
      }
      this.#assertNotDisposed();
      this.#activeNode.token.navigationReady = true;
      this.#activeNode.mounted.activate?.();
      this.#see("nodes", next.currentNodeId);
    } catch (cause) {
      this.#recordError(cause, next.currentNodeId);
      if (!this.#disposed) await this.#failRuntime();
      throw cause;
    }
    // A way around the game does not move the save from the story.
    if (leftStoryAt === undefined) await this.#checkpoint();
    else this.#leftStoryAt = leftStoryAt;
  }

  async #failRuntime(): Promise<void> {
    this.#failed = true;
    this.#started = false;
    await this.#disposeActiveSurface(this.#activeNode);
    this.#activeNode = undefined;
    this.#stateListeners.clear();
  }

  async #mountNode(nodeId: string): Promise<ActiveSurface> {
    const node = playableNodeById(this.#graph, nodeId);
    if (!node)
      throw new NodeRuntimeError(
        "missing-compiled-surface",
        `Playable Node "${nodeId}" is missing.`,
      );
    const surface = this.#compiled.nodes[nodeId];
    if (!surface)
      throw new NodeRuntimeError(
        "missing-compiled-surface",
        `Compiled Playable Node "${nodeId}" is missing.`,
      );
    const token: SurfaceToken = {
      surfaceId: nodeId,
      active: true,
      navigationReady: false,
    };
    const abortController = new AbortController();
    this.#mountingAbortController = abortController;
    const base = this.#baseContext(token, abortController, node.assets);
    // A Node is marked seen once it has mounted, so this counts earlier visits only.
    const seenBefore = this.#policy !== "report" && Object.hasOwn(this.#seen.nodes, nodeId);
    const context: Omit<PlayableNodeContext, "root"> = {
      ...base,
      story: { ...base.story, seenBefore },
      navigation: {
        emit: this.#guardAsync(token, (signal: string) =>
          this.#emit(token, signal),
        ),
        back: this.#guardAsync(token, () => this.#back(token)),
        connected: this.#guard(token, (signal: string) => {
          this.#assertSurfaceActive(token);
          return node.signals.some((candidate) => candidate.id === signal)
            && playableEdgeForSignal(this.#graph, nodeId, signal) !== undefined;
        }),
      },
    };
    try {
      const mounted = await this.#surfaceHost.mountNode(surface, context);
      await this.#validateMountedSurface(mounted);
      return { token, abortController, mounted };
    } catch (cause) {
      token.active = false;
      abortController.abort();
      throw cause;
    } finally {
      if (this.#mountingAbortController === abortController)
        this.#mountingAbortController = undefined;
    }
  }

  async #validateMountedSurface(
    mounted: PlayableMountedSurface,
  ): Promise<void> {
    if (
      mounted.cleanup !== undefined &&
      typeof mounted.cleanup !== "function"
    ) {
      try {
        await mounted.destroy();
      } catch (cause) {
        this.#reportError(cause);
      }
      throw new NodeRuntimeError(
        "invalid-cleanup",
        "Playable mount() returned a value that is not a cleanup function.",
      );
    }
  }

  #baseContext(
    token: SurfaceToken,
    abortController: AbortController,
    declaredAssets: readonly string[],
  ): Omit<NodeRuntimeContext, "root"> {
    return {
      assets: {
        url: this.#guard(token, (id: string) =>
          this.#assetUrl(token, declaredAssets, id),
        ),
      },
      state: this.#stateService(token, abortController.signal),
      position: {
        get: this.#guard(token, () => {
          this.#assertSurfaceActive(token);
          return structuredClone(this.#positions.current);
        }),
        set: this.#guardAsync(token, async (value: JsonValue | null) => {
          this.#assertSurfaceActive(token);
          this.#positions = { ...this.#positions, current: checkedPosition(value) };
          this.#changed();
          await this.#checkpoint();
        }),
      },
      audio: {
        music: this.#guard(token, (assetId: string | null, options?: { fade?: number }) => {
          if (assetId !== null) this.#assetUrl(token, declaredAssets, assetId);
          else this.#assertSurfaceActive(token);
          const fade = options?.fade ?? DEFAULT_MUSIC_FADE;
          if (typeof fade !== "number" || !Number.isFinite(fade) || fade < 0)
            throw new TypeError("Music fade must be a number of seconds, 0 or more.");
          this.#playMusic(assetId ?? undefined, fade);
        }),
        sound: this.#guard(token, (assetId: string) => {
          this.#audio?.sound(this.#assetUrl(token, declaredAssets, assetId));
        }),
      },
      preferences: {
        get: this.#guard(token, () => {
          this.#assertSurfaceActive(token);
          return { ...PLAYABLE_DEFAULT_PREFERENCES, ...cloneJsonObject(this.#preferences) };
        }),
        set: this.#guardAsync(token, async (values: JsonObject) => {
          this.#assertSurfaceActive(token);
          await this.#setPreferences(values);
        }),
      },
      session: {
        hasSave: () => this.#cachedSave !== undefined,
        reset: this.#guardAsync(token, () => this.#reset(token)),
        continue: this.#guardAsync(token, () => this.#continue(token)),
        save: this.#guardAsync(token, () => this.#save(token)),
        restart: this.#guardAsync(token, () => this.#restart(token)),
        slots: this.#guard(token, () => {
          this.#assertSurfaceActive(token);
          return this.#slotSummaries();
        }),
        saveSlot: this.#guardAsync(token, (id: string, note?: string) => this.#saveSlot(token, id, note)),
        loadSlot: this.#guardAsync(token, (id: string) => this.#loadSlot(token, id)),
        deleteSlot: this.#guardAsync(token, (id: string) => this.#deleteSlot(token, id)),
      },
      story: {
        map: this.#guard(token, () => {
          this.#assertSurfaceActive(token);
          this.#storyLayout ??= layoutPlayableStory(this.#graph);
          // A preview shows the author the whole map, not one player's progress.
          return playableStoryMap(this.#storyLayout, this.#policy === "report" ? "all" : this.#seen);
        }),
      },
      lifecycle: { signal: abortController.signal },
    };
  }

  /** Records errors thrown by a context method against the calling surface. */
  #guard<A extends unknown[], R>(
    token: SurfaceToken,
    operation: (...args: A) => R,
  ): (...args: A) => R {
    return (...args) => {
      try {
        return operation(...args);
      } catch (cause) {
        this.#reportError(cause, token.surfaceId);
        throw cause;
      }
    };
  }

  #guardAsync<A extends unknown[]>(
    token: SurfaceToken,
    operation: (...args: A) => Promise<void>,
  ): (...args: A) => Promise<void> {
    return async (...args) => {
      try {
        await operation(...args);
      } catch (cause) {
        this.#reportError(cause, token.surfaceId);
        throw cause;
      }
    };
  }

  /** False when the error was already recorded. */
  #recordError(error: unknown, nodeId?: string): boolean {
    if (typeof error === "object" && error !== null) {
      if (this.#recordedErrors.has(error)) return false;
      this.#recordedErrors.add(error);
    }
    const code =
      error instanceof Error && typeof Reflect.get(error, "code") === "string"
        ? (Reflect.get(error, "code") as string)
        : "surface-error";
    this.#errors = [
      ...this.#errors,
      {
        ...(nodeId ? { nodeId } : {}),
        code,
        message: error instanceof Error ? error.message : String(error),
        at: this.#now().toISOString(),
      },
    ].slice(-HISTORY_LIMIT);
    this.#changed();
    return true;
  }

  #recordStateAccess(
    token: SurfaceToken,
    kind: "read" | "wrote",
    keys: readonly string[],
  ): void {
    let access = this.#stateAccess.get(token.surfaceId);
    if (!access) {
      access = { read: new Set(), wrote: new Set() };
      this.#stateAccess.set(token.surfaceId, access);
    }
    const target = access[kind];
    const size = target.size;
    for (const key of keys) target.add(key);
    if (target.size !== size) this.#changed();
  }

  #changed(): void {
    try {
      this.#onChange();
    } catch {
      // Change notification must not interrupt Runtime operations.
    }
  }

  #stateService(
    token: SurfaceToken,
    lifecycle: AbortSignal,
  ): PlayableStateService {
    return {
      get: this.#guard(token, (key?: string) => {
        this.#assertSurfaceActive(token);
        if (key === undefined) {
          this.#recordStateAccess(token, "read", ["*"]);
          return cloneJsonObject(this.#state);
        }
        if (!Object.hasOwn(this.#graph.initialState, key)) {
          throw new PlayableStateError(
            "unknown-state-key",
            `Project State key "${key}" is not declared in initialState.`,
          );
        }
        this.#recordStateAccess(token, "read", [key]);
        return structuredClone(this.#state[key]);
      }) as PlayableStateService["get"],
      set: this.#guardAsync(token, async (key: string, value: JsonValue) => {
        this.#assertSurfaceActive(token);
        this.#state = setPlayableState(
          this.#graph.initialState,
          this.#state,
          key,
          value,
        );
        this.#recordStateAccess(token, "wrote", [key]);
        this.#notifyState();
        await this.#checkpoint();
      }),
      patch: this.#guardAsync(token, async (values: JsonObject) => {
        this.#assertSurfaceActive(token);
        this.#state = patchPlayableState(
          this.#graph.initialState,
          this.#state,
          values,
        );
        this.#recordStateAccess(token, "wrote", Object.keys(values));
        this.#notifyState();
        await this.#checkpoint();
      }),
      subscribe: this.#guard(token, (listener: (state: Readonly<JsonObject>) => void) => {
        this.#assertSurfaceActive(token);
        this.#recordStateAccess(token, "read", ["*"]);
        const activeListener = (state: Readonly<JsonObject>) => {
          if (token.active) listener(state);
        };
        this.#stateListeners.add(activeListener);
        const unsubscribe = () => this.#stateListeners.delete(activeListener);
        lifecycle.addEventListener("abort", unsubscribe, { once: true });
        return unsubscribe;
      }),
    };
  }

  #assetUrl(
    token: SurfaceToken,
    declaredAssets: readonly string[],
    id: string,
  ): string {
    this.#assertSurfaceActive(token);
    if (!declaredAssets.includes(id)) {
      throw new NodeRuntimeError(
        "undeclared-asset",
        `Asset "${id}" is not declared for this Playable surface.`,
      );
    }
    const url = this.#assetUrls[id];
    if (typeof url !== "string" || url.length === 0) {
      throw new NodeRuntimeError(
        "missing-asset-url",
        `Asset "${id}" has no runtime URL.`,
      );
    }
    return url;
  }

  async #reset(token: SurfaceToken): Promise<void> {
    this.#assertNavigationReady(token);
    this.#state = createPlayableState(this.#graph.initialState);
    this.#navigation = { ...this.#navigation, backStack: [] };
    this.#positions = NO_POSITIONS;
    this.#notifyState();
    await this.#checkpoint();
  }

  async #restart(token: SurfaceToken): Promise<void> {
    this.#assertNavigationReady(token);
    if (this.#policy === "report") {
      this.#report({
        kind: "restart",
        targetNodeId: this.#graph.entryNodeId,
        at: this.#now().toISOString(),
      });
      return;
    }
    await this.#navigate(
      () => createPlayableNavigation(this.#graph),
      () => {
        this.#state = createPlayableState(this.#graph.initialState);
        this.#positions = NO_POSITIONS;
        this.#playMusic(undefined, DEFAULT_MUSIC_FADE);
        this.#notifyState();
      },
    );
  }

  async #continue(token: SurfaceToken): Promise<void> {
    this.#assertNavigationReady(token);
    const save = this.#cachedSave;
    if (!save)
      throw new NodeRuntimeError(
        "no-save",
        "There is no compatible Playable save to continue.",
      );
    await this.#restore(save);
  }

  /** Continues a save: its Node, back stack, State, positions, and music. */
  async #restore(save: PlayableSave): Promise<void> {
    if (this.#policy === "report") {
      this.#report({
        kind: "continue",
        targetNodeId: save.currentNodeId,
        at: this.#now().toISOString(),
      });
      return;
    }
    await this.#navigate(
      () => ({
        currentNodeId: save.currentNodeId,
        backStack: [...save.backStack],
      }),
      () => {
        this.#state = patchPlayableState(
          this.#graph.initialState,
          this.#graph.initialState,
          save.state,
        );
        this.#positions = {
          current: structuredClone(save.position ?? null),
          back: save.backStack.map((_, index) => structuredClone(save.backPositions?.[index] ?? null)),
        };
        this.#playMusic(save.music, DEFAULT_MUSIC_FADE);
        this.#notifyState();
      },
    );
  }

  #playMusic(assetId: string | undefined, fade: number): void {
    if (assetId === this.#music) return;
    this.#music = assetId;
    this.#audio?.music(assetId === undefined ? undefined : this.#assetUrls[assetId], fade);
    this.#changed();
  }

  #applyVolumes(): void {
    const preferences = { ...PLAYABLE_DEFAULT_PREFERENCES, ...this.#preferences };
    this.#audio?.volumes({
      music: preferences.musicVolume as number,
      sound: preferences.soundVolume as number,
    });
  }

  async #setPreferences(values: JsonObject): Promise<void> {
    if (!isJsonObject(values))
      throw new NodeRuntimeError("invalid-preferences", "Preferences must be a JSON object.");
    const next = parsePreferences({ ...this.#preferences, ...structuredClone(values) }, true);
    this.#preferences = next;
    this.#applyVolumes();
    this.#changed();
    const write = () => this.#preferencesStore.save(cloneJsonObject(next));
    this.#preferencesQueue = this.#preferencesQueue.then(write, write).catch((cause: unknown) => {
      if (this.#preferencesSaveFailed) return;
      this.#preferencesSaveFailed = true;
      this.#reportError(cause);
    });
    await this.#preferencesQueue;
  }

  #slotSummaries(): PlayableSlotSummary[] {
    return Object.entries(this.#slots)
      .filter(([id]) => SLOT_ID_PATTERN.test(id))
      .map(([id, value]): PlayableSlotSummary | undefined => {
        const slot = isRecord(value) ? value : {};
        const note = typeof slot.note === "string" ? slot.note : undefined;
        const save = this.#parseSave(slot.save);
        if (save) return { id, savedAt: save.savedAt, nodeId: save.currentNodeId, ...(note ? { note } : {}) };
        // Another version's slot still shows, so the player does not think it is empty.
        const stored = isRecord(slot.save) ? slot.save : {};
        if (typeof stored.savedAt !== "string" || typeof stored.currentNodeId !== "string") return undefined;
        return { id, savedAt: stored.savedAt, nodeId: stored.currentNodeId, ...(note ? { note } : {}), incompatible: true };
      })
      .filter((summary) => summary !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  }

  async #saveSlot(token: SurfaceToken, id: string, note?: string): Promise<void> {
    this.#assertSurfaceActive(token);
    checkSlotId(id);
    if (note !== undefined && (typeof note !== "string" || note.length > MAX_SLOT_NOTE))
      throw new NodeRuntimeError("invalid-slot", `A slot note must be text of at most ${MAX_SLOT_NOTE} characters.`);
    if (!Object.hasOwn(this.#slots, id) && Object.keys(this.#slots).length >= MAX_SLOTS)
      throw new NodeRuntimeError("invalid-slot", `A game keeps at most ${MAX_SLOTS} slots.`);
    // Away from the story, such as in a menu reached by a navigation Signal, a slot keeps where the story is.
    const save = this.#leftStoryAt !== undefined && this.#cachedSave ? this.#cachedSave : this.#currentSave();
    await this.#writeSlots({ ...this.#slots, [id]: { save, ...(note ? { note } : {}) } });
  }

  async #loadSlot(token: SurfaceToken, id: string): Promise<void> {
    this.#assertNavigationReady(token);
    checkSlotId(id);
    const slot = this.#slots[id];
    if (slot === undefined)
      throw new NodeRuntimeError("no-save", `Slot "${id}" is empty.`);
    const save = this.#parseSave(isRecord(slot) ? slot.save : undefined);
    if (!save)
      throw new NodeRuntimeError("no-save", `Slot "${id}" was saved by another version of the game and cannot be loaded.`);
    await this.#restore(save);
  }

  async #deleteSlot(token: SurfaceToken, id: string): Promise<void> {
    this.#assertSurfaceActive(token);
    checkSlotId(id);
    if (!Object.hasOwn(this.#slots, id)) return;
    const slots = { ...this.#slots };
    delete slots[id];
    await this.#writeSlots(slots);
  }

  async #writeSlots(slots: Record<string, unknown>): Promise<void> {
    const write = async () => {
      await this.#slotStore.save(structuredClone(slots));
      this.#slots = slots;
      this.#changed();
    };
    this.#slotQueue = this.#slotQueue.then(write, write);
    await this.#slotQueue;
  }

  async #save(token: SurfaceToken): Promise<void> {
    this.#assertSurfaceActive(token);
    await this.#checkpoint();
  }

  #currentSave(): PlayableSave {
    return {
      version: 1,
      graphVersion: this.#graph.version,
      graphSignature: this.#graphSignature,
      savedAt: this.#now().toISOString(),
      currentNodeId: this.#navigation.currentNodeId,
      backStack: [...this.#navigation.backStack],
      state: cloneJsonObject(this.#state),
      ...(this.#positions.current !== null ? { position: structuredClone(this.#positions.current) } : {}),
      ...(this.#positions.back.some((position) => position !== null)
        ? { backPositions: structuredClone(this.#positions.back) }
        : {}),
      ...(this.#music ? { music: this.#music } : {}),
    };
  }

  async #checkpoint(): Promise<void> {
    this.#leftStoryAt = undefined;
    const save = this.#currentSave();
    const write = async () => {
      await this.#saveStore.save(save);
      this.#cachedSave = save;
      this.#incompatibleSave = false;
      this.#changed();
    };
    this.#saveQueue = this.#saveQueue.then(write, write);
    await this.#saveQueue;
  }

  /**
   * Records the first time the player enters a Node or takes an edge. Only
   * play counts: the `report` policy previews a Node without the player.
   * A failed write does not stop the game; the first one is reported, and
   * later writes still try.
   */
  #see(kind: "nodes" | "edges", id: string): void {
    if (this.#policy === "report" || Object.hasOwn(this.#seen[kind], id)) return;
    this.#seen = { ...this.#seen, [kind]: { ...this.#seen[kind], [id]: this.#now().toISOString() } };
    const seen = this.#seen;
    this.#seenQueue = this.#seenQueue
      .then(() => this.#seenStore.save(seen))
      .catch((cause: unknown) => {
        if (this.#seenSaveFailed) return;
        this.#seenSaveFailed = true;
        this.#reportError(cause);
      });
  }

  #parseSave(value: unknown): PlayableSave | undefined {
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.graphVersion !== this.#graph.version ||
      value.graphSignature !== this.#graphSignature ||
      typeof value.savedAt !== "string" ||
      !Number.isFinite(Date.parse(value.savedAt)) ||
      typeof value.currentNodeId !== "string" ||
      !Array.isArray(value.backStack) ||
      !value.backStack.every((nodeId) => typeof nodeId === "string") ||
      !isJsonObject(value.state)
    )
      return undefined;
    if (
      !playableNodeById(this.#graph, value.currentNodeId) ||
      value.backStack.some((nodeId) => !playableNodeById(this.#graph, nodeId))
    )
      return undefined;
    try {
      const state = patchPlayableState(
        this.#graph.initialState,
        this.#graph.initialState,
        value.state,
      );
      // Saves from before positions and music, or with ones this graph lacks, still continue.
      const position = isJsonValue(value.position) ? value.position : undefined;
      const backPositions = Array.isArray(value.backPositions)
        && value.backPositions.length === value.backStack.length
        && value.backPositions.every(isJsonValue)
        ? value.backPositions as (JsonValue | null)[]
        : undefined;
      const music = typeof value.music === "string" && this.#graph.assets[value.music]?.type === "audio"
        ? value.music
        : undefined;
      return {
        version: 1,
        graphVersion: 1,
        graphSignature: value.graphSignature,
        savedAt: value.savedAt,
        currentNodeId: value.currentNodeId,
        backStack: [...value.backStack],
        state,
        ...(position !== undefined && position !== null ? { position: structuredClone(position) } : {}),
        ...(backPositions ? { backPositions: structuredClone(backPositions) } : {}),
        ...(music ? { music } : {}),
      };
    } catch {
      return undefined;
    }
  }

  #notifyState(): void {
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(cloneJsonObject(this.#state));
      } catch (error) {
        this.#reportError(error);
      }
    }
    this.#changed();
  }

  async #disposeActiveSurface(
    surface: ActiveSurface | undefined,
  ): Promise<void> {
    if (!surface) return;
    this.#deactivateSurface(surface);
    surface.abortController.abort();
    try {
      await surface.mounted.cleanup?.();
    } catch (cause) {
      this.#reportError(cause);
    }
    try {
      await surface.mounted.destroy();
    } catch (cause) {
      this.#reportError(cause);
    }
  }

  #deactivateSurface(surface: ActiveSurface | undefined): void {
    if (!surface || !surface.token.active) return;
    surface.token.active = false;
    try {
      surface.mounted.deactivate?.();
    } catch (cause) {
      this.#reportError(cause);
    }
  }

  #assertSurfaceActive(token: SurfaceToken): void {
    this.#assertStarted();
    if (!token.active)
      throw new NodeRuntimeError(
        "stale-surface",
        "This Playable surface is no longer active.",
      );
  }

  #assertNavigationReady(token: SurfaceToken): void {
    this.#assertSurfaceActive(token);
    if (!token.navigationReady || this.#transitioning) {
      throw new NodeRuntimeError(
        "navigation-in-progress",
        "Playable navigation is unavailable while a surface is mounting or another navigation is in progress.",
      );
    }
  }

  #reportError(error: unknown, nodeId?: string): void {
    if (!this.#recordError(error, nodeId)) return;
    try {
      this.#onError(error);
    } catch {
      // Error reporting must not interrupt surface lifecycle operations.
    }
  }

  #assertStarted(): void {
    this.#assertNotDisposed();
    this.#assertNotFailed();
    if (!this.#started)
      throw new NodeRuntimeError(
        "not-started",
        "Node Runtime has not started.",
      );
  }

  #assertNotDisposed(): void {
    if (this.#disposed)
      throw new NodeRuntimeError(
        "disposed",
        "Node Runtime has been disposed.",
      );
  }

  #assertNotFailed(): void {
    if (this.#failed)
      throw new NodeRuntimeError(
        "runtime-failed",
        "Node Runtime stopped after startup or a surface transition failed.",
      );
  }
}

export class MemoryPlayableSaveStore implements PlayableSaveStore {
  #value: PlayableSave | undefined;

  constructor(initial?: PlayableSave) {
    this.#value = initial ? structuredClone(initial) : undefined;
  }

  async load(): Promise<unknown | undefined> {
    return this.#value ? structuredClone(this.#value) : undefined;
  }

  async save(save: PlayableSave): Promise<void> {
    this.#value = structuredClone(save);
  }
}

export class MemoryPlayableSlotStore implements PlayableSlotStore {
  #value: Record<string, unknown> | undefined;

  constructor(initial?: Record<string, unknown>) {
    this.#value = initial ? structuredClone(initial) : undefined;
  }

  async load(): Promise<unknown | undefined> {
    return this.#value ? structuredClone(this.#value) : undefined;
  }

  async save(slots: Record<string, unknown>): Promise<void> {
    this.#value = structuredClone(slots);
  }
}

export class MemoryPlayablePreferencesStore implements PlayablePreferencesStore {
  #value: JsonObject | undefined;

  constructor(initial?: JsonObject) {
    this.#value = initial ? structuredClone(initial) : undefined;
  }

  async load(): Promise<unknown | undefined> {
    return this.#value ? structuredClone(this.#value) : undefined;
  }

  async save(preferences: JsonObject): Promise<void> {
    this.#value = structuredClone(preferences);
  }
}

export class MemoryPlayableSeenStore implements PlayableSeenStore {
  #value: PlayableSeen | undefined;

  constructor(initial?: PlayableSeen) {
    this.#value = initial ? structuredClone(initial) : undefined;
  }

  async load(): Promise<unknown | undefined> {
    return this.#value ? structuredClone(this.#value) : undefined;
  }

  async save(seen: PlayableSeen): Promise<void> {
    this.#value = structuredClone(seen);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function checkedPosition(value: JsonValue | null): JsonValue | null {
  if (!isJsonValue(value) || JSON.stringify(value).length > MAX_POSITION_BYTES)
    throw new NodeRuntimeError(
      "invalid-position",
      `A position must be JSON of at most ${MAX_POSITION_BYTES} bytes.`,
    );
  return structuredClone(value);
}

function checkSlotId(id: string): void {
  if (typeof id !== "string" || !SLOT_ID_PATTERN.test(id))
    throw new NodeRuntimeError(
      "invalid-slot",
      `Slot "${String(id)}" must be 1 to 40 letters, digits, dashes, or underscores.`,
    );
}

/**
 * Settings as stored. With `strict`, a bad value throws, as it does when a
 * Node sets one; otherwise stored settings that cannot be read start over.
 */
function parsePreferences(value: unknown, strict = false): JsonObject {
  const fail = (message: string): JsonObject => {
    if (strict) throw new NodeRuntimeError("invalid-preferences", message);
    return {};
  };
  if (value === undefined || value === null) return {};
  if (!isJsonObject(value)) return fail("Preferences must be a JSON object.");
  for (const key of ["musicVolume", "soundVolume"] as const) {
    const volume = value[key];
    if (volume !== undefined && (typeof volume !== "number" || !(volume >= 0 && volume <= 1)))
      return fail(`Preference "${key}" must be a number from 0 to 1.`);
  }
  if (JSON.stringify(value).length > MAX_PREFERENCES_BYTES)
    return fail(`Preferences must be at most ${MAX_PREFERENCES_BYTES} bytes.`);
  return cloneJsonObject(value);
}
