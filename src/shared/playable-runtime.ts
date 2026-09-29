import type {
  CompiledNodeGraph,
  CompiledPlayableSurface,
} from "./playable-compiled.js";
import { playableNodeById } from "./playable-graph.js";
import {
  createPlayableNavigation,
  navigatePlayableBack,
  navigatePlayableSignal,
  openPlayableDestination,
  type PlayableNavigationState,
} from "./playable-navigation.js";
import type {
  JsonObject,
  JsonValue,
  PlayableCleanup,
  NodeGraph,
  PlayableNavigationMode,
  PlayableNodeContext,
  NodeRuntimeContext,
  PlayableShellContext,
  PlayableStateService,
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
  mountShell(
    surface: CompiledPlayableSurface,
    context: Omit<PlayableShellContext, "root">,
  ): Promise<PlayableMountedSurface>;
}

export interface NodeRuntimeOptions {
  graph: NodeGraph;
  compiled: CompiledNodeGraph;
  graphSignature: string;
  surfaceHost: PlayableSurfaceHost;
  saveStore: PlayableSaveStore;
  assetUrls: Readonly<Record<string, string>>;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface NodeRuntimeSnapshot {
  currentNodeId: string;
  backStack: string[];
  recentSignals: Array<{ nodeId: string; signal: string }>;
  state: JsonObject;
  hasSave: boolean;
  started: boolean;
  transitioning: boolean;
  failed: boolean;
}

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
  active: boolean;
  navigationReady: boolean;
}

export class NodeRuntime {
  readonly #graph: NodeGraph;
  readonly #compiled: CompiledNodeGraph;
  readonly #graphSignature: string;
  readonly #surfaceHost: PlayableSurfaceHost;
  readonly #saveStore: PlayableSaveStore;
  readonly #assetUrls: Readonly<Record<string, string>>;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #stateListeners = new Set<(state: Readonly<JsonObject>) => void>();

  #navigation: PlayableNavigationState;
  #state: JsonObject;
  #recentSignals: Array<{ nodeId: string; signal: string }> = [];
  #cachedSave?: PlayableSave;
  #activeNode?: ActiveSurface;
  #activeShell?: ActiveSurface;
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
    this.#navigation = createPlayableNavigation(options.graph);
    this.#state = createPlayableState(options.graph.initialState);
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
    const operation = this.#performStart();
    this.#activeOperation = operation;
    try {
      await operation;
    } finally {
      this.#starting = false;
      if (this.#activeOperation === operation)
        this.#activeOperation = undefined;
    }
  }

  async #performStart(): Promise<void> {
    try {
      this.#cachedSave = this.#parseSave(await this.#saveStore.load());
      this.#assertNotDisposed();
      this.#started = true;
      if (this.#graph.shell) {
        const surface = this.#compiled.shell;
        if (!surface)
          throw new NodeRuntimeError(
            "missing-compiled-surface",
            "Compiled Shell is missing.",
          );
        this.#activeShell = await this.#mountShell(surface);
        this.#assertNotDisposed();
      }
      this.#activeNode = await this.#mountNode(this.#navigation.currentNodeId);
      this.#assertNotDisposed();
      this.#activeNode.token.navigationReady = true;
      if (this.#activeShell) this.#activeShell.token.navigationReady = true;
    } catch (cause) {
      if (!this.#disposed) this.#failed = true;
      await this.#disposeActiveSurface(this.#activeNode);
      await this.#disposeActiveSurface(this.#activeShell);
      this.#activeNode = undefined;
      this.#activeShell = undefined;
      this.#started = false;
      throw cause;
    }
  }

  snapshot(): NodeRuntimeSnapshot {
    return {
      currentNodeId: this.#navigation.currentNodeId,
      backStack: [...this.#navigation.backStack],
      recentSignals: this.#recentSignals.map((entry) => ({ ...entry })),
      state: cloneJsonObject(this.#state),
      hasSave: this.#cachedSave !== undefined,
      started: this.#started,
      transitioning: this.#transitioning,
      failed: this.#failed,
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#started = false;
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
    await this.#disposeActiveSurface(this.#activeShell);
    this.#activeNode = undefined;
    this.#activeShell = undefined;
    this.#stateListeners.clear();
  }

  async #emit(token: SurfaceToken, signal: string): Promise<void> {
    this.#assertNavigationReady(token);
    this.#recentSignals = [
      ...this.#recentSignals,
      { nodeId: this.#navigation.currentNodeId, signal },
    ].slice(-10);
    await this.#navigate(() =>
      navigatePlayableSignal(this.#graph, this.#navigation, signal),
    );
  }

  async #open(
    token: SurfaceToken,
    destination: string,
    mode: PlayableNavigationMode = "replace",
  ): Promise<void> {
    this.#assertNavigationReady(token);
    await this.#navigate(() =>
      openPlayableDestination(this.#graph, this.#navigation, destination, mode),
    );
  }

  async #back(token: SurfaceToken): Promise<void> {
    this.#assertNavigationReady(token);
    await this.#navigate(() => navigatePlayableBack(this.#navigation));
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
    const operation = this.#performNavigation(next, prepare);
    this.#activeOperation = operation;
    try {
      await operation;
    } finally {
      this.#transitioning = false;
      if (this.#activeOperation === operation)
        this.#activeOperation = undefined;
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
      if (!this.#disposed) await this.#failRuntime();
      throw cause;
    }
    await this.#checkpoint();
  }

  async #failRuntime(): Promise<void> {
    this.#failed = true;
    this.#started = false;
    await this.#disposeActiveSurface(this.#activeNode);
    await this.#disposeActiveSurface(this.#activeShell);
    this.#activeNode = undefined;
    this.#activeShell = undefined;
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
    const token: SurfaceToken = { active: true, navigationReady: false };
    const abortController = new AbortController();
    const context: Omit<PlayableNodeContext, "root"> = {
      ...this.#baseContext(token, abortController, node.assets),
      navigation: {
        emit: (signal) => this.#emit(token, signal),
        back: () => this.#back(token),
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

  async #mountShell(surface: CompiledPlayableSurface): Promise<ActiveSurface> {
    const token: SurfaceToken = { active: true, navigationReady: false };
    const abortController = new AbortController();
    const context: Omit<PlayableShellContext, "root"> = {
      ...this.#baseContext(
        token,
        abortController,
        this.#graph.shell?.assets ?? [],
      ),
      navigation: {
        back: () => this.#back(token),
        open: (destination, mode) => this.#open(token, destination, mode),
      },
    };
    try {
      const mounted = await this.#surfaceHost.mountShell(surface, context);
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
      assets: { url: (id) => this.#assetUrl(token, declaredAssets, id) },
      state: this.#stateService(token, abortController.signal),
      session: {
        hasSave: () => this.#cachedSave !== undefined,
        reset: () => this.#reset(token),
        continue: () => this.#continue(token),
        save: () => this.#save(token),
        restart: () => this.#restart(token),
      },
      lifecycle: { signal: abortController.signal },
    };
  }

  #stateService(
    token: SurfaceToken,
    lifecycle: AbortSignal,
  ): PlayableStateService {
    return {
      get: ((key?: string) => {
        this.#assertSurfaceActive(token);
        if (key === undefined) return cloneJsonObject(this.#state);
        if (!Object.hasOwn(this.#graph.initialState, key)) {
          throw new PlayableStateError(
            "unknown-state-key",
            `Project State key "${key}" is not declared in initialState.`,
          );
        }
        return structuredClone(this.#state[key]);
      }) as PlayableStateService["get"],
      set: async (key, value) => {
        this.#assertSurfaceActive(token);
        this.#state = setPlayableState(
          this.#graph.initialState,
          this.#state,
          key,
          value,
        );
        this.#notifyState();
        await this.#checkpoint();
      },
      patch: async (values) => {
        this.#assertSurfaceActive(token);
        this.#state = patchPlayableState(
          this.#graph.initialState,
          this.#state,
          values,
        );
        this.#notifyState();
        await this.#checkpoint();
      },
      subscribe: (listener) => {
        this.#assertSurfaceActive(token);
        this.#stateListeners.add(listener);
        const unsubscribe = () => this.#stateListeners.delete(listener);
        lifecycle.addEventListener("abort", unsubscribe, { once: true });
        return unsubscribe;
      },
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

  #reportError(error: unknown): void {
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

export function localStoragePlayableSaveStore(
  storage: Storage,
  key: string,
): PlayableSaveStore {
  return {
    async load() {
      const value = storage.getItem(key);
      if (value === null) return undefined;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    },
    async save(save) {
      storage.setItem(key, JSON.stringify(save));
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
