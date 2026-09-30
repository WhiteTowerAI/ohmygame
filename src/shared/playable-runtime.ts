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
  type PlayableStateService,
} from "./playable-nodes.js";
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
}

export interface PlayableSaveStore {
  load(): Promise<unknown | undefined>;
  save(save: PlayableSave): Promise<void>;
}

export interface PlayableMountedSurface {
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
}

const HISTORY_LIMIT = 20;

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
  | "invalid-cleanup";

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
  #started = false;
  #starting = false;
  #disposed = false;
  #failed = false;
  #transitioning = false;
  #activeOperation?: Promise<void>;
  #disposePromise?: Promise<void>;
  #saveQueue: Promise<void> = Promise.resolve();

  constructor(options: NodeRuntimeOptions) {
    this.#graph = options.graph;
    this.#compiled = options.compiled;
    this.#graphSignature = options.graphSignature;
    this.#surfaceHost = options.surfaceHost;
    this.#saveStore = options.saveStore;
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
      this.#assertNotDisposed();
      this.#started = true;
      this.#activeNode = await this.#mountNode(this.#navigation.currentNodeId);
      this.#assertNotDisposed();
      this.#activeNode.token.navigationReady = true;
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
    await this.#disposeActiveSurface(this.#activeNode);
    this.#activeNode = undefined;
    this.#stateListeners.clear();
  }

  async #emit(token: SurfaceToken, signal: string): Promise<void> {
    this.#assertNavigationReady(token);
    const nodeId = this.#navigation.currentNodeId;
    const node = playableNodeById(this.#graph, nodeId);
    if (!node?.signals.some((candidate) => candidate.id === signal)) {
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
    await this.#navigate(() =>
      navigatePlayableSignal(this.#graph, this.#navigation, signal),
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
    await this.#navigate(() => navigatePlayableBack(this.#navigation));
  }

  #report(report: NodeRuntimeNavigationReport): void {
    this.#reports = [...this.#reports, report].slice(-HISTORY_LIMIT);
    this.#changed();
  }

  async #navigate(
    resolve: () => PlayableNavigationState,
    prepare?: () => void,
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
    const operation = this.#performNavigation(next, prepare);
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
  ): Promise<void> {
    try {
      prepare?.();
      const previous = this.#activeNode;
      this.#activeNode = undefined;
      await this.#disposeActiveSurface(previous);
      this.#navigation = next;
      this.#activeNode = await this.#mountNode(next.currentNodeId);
      this.#assertNotDisposed();
      this.#activeNode.token.navigationReady = true;
    } catch (cause) {
      this.#recordError(cause, next.currentNodeId);
      if (!this.#disposed) await this.#failRuntime();
      throw cause;
    }
    await this.#checkpoint();
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
    const context: Omit<PlayableNodeContext, "root"> = {
      ...this.#baseContext(token, abortController, node.assets),
      navigation: {
        emit: this.#guardAsync(token, (signal: string) =>
          this.#emit(token, signal),
        ),
        back: this.#guardAsync(token, () => this.#back(token)),
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
      session: {
        hasSave: () => this.#cachedSave !== undefined,
        reset: this.#guardAsync(token, () => this.#reset(token)),
        continue: this.#guardAsync(token, () => this.#continue(token)),
        save: this.#guardAsync(token, () => this.#save(token)),
        restart: this.#guardAsync(token, () => this.#restart(token)),
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
        this.#stateListeners.add(listener);
        const unsubscribe = () => this.#stateListeners.delete(listener);
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
        this.#notifyState();
      },
    );
  }

  async #save(token: SurfaceToken): Promise<void> {
    this.#assertSurfaceActive(token);
    await this.#checkpoint();
  }

  async #checkpoint(): Promise<void> {
    const save: PlayableSave = {
      version: 1,
      graphVersion: this.#graph.version,
      graphSignature: this.#graphSignature,
      savedAt: this.#now().toISOString(),
      currentNodeId: this.#navigation.currentNodeId,
      backStack: [...this.#navigation.backStack],
      state: cloneJsonObject(this.#state),
    };
    const write = async () => {
      await this.#saveStore.save(save);
      this.#cachedSave = save;
      this.#incompatibleSave = false;
      this.#changed();
    };
    this.#saveQueue = this.#saveQueue.then(write, write);
    await this.#saveQueue;
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
      return {
        version: 1,
        graphVersion: 1,
        graphSignature: value.graphSignature,
        savedAt: value.savedAt,
        currentNodeId: value.currentNodeId,
        backStack: [...value.backStack],
        state,
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
    surface.token.active = false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
