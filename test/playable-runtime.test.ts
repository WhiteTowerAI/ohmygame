import { describe, expect, it } from "vitest";
import type {
  CompiledNodeGraph,
  CompiledPlayableSurface,
} from "../src/shared/playable-compiled.js";
import type {
  PlayableNodeContext,
  PlayableShellContext,
} from "../src/shared/playable-nodes.js";
import {
  MemoryPlayableSaveStore,
  NodeRuntime,
  type NodeRuntimeOptions,
  type PlayableMountedSurface,
  type PlayableSave,
  type PlayableSaveStore,
  type PlayableSurfaceHost,
} from "../src/shared/playable-runtime.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

type NodeContext = Omit<PlayableNodeContext, "root">;
type ShellContext = Omit<PlayableShellContext, "root">;

class FakeSurfaceHost implements PlayableSurfaceHost {
  readonly events: string[] = [];
  readonly nodeContexts: Array<{ id: string; context: NodeContext }> = [];
  readonly shellContexts: ShellContext[] = [];
  onMountNode?: (
    surface: CompiledPlayableSurface,
    context: NodeContext,
  ) => void | Promise<void>;
  onMountShell?: (
    surface: CompiledPlayableSurface,
    context: ShellContext,
  ) => void | Promise<void>;
  nodeCleanup?: (id: string, context: NodeContext) => void | Promise<void>;
  nodeDestroy?: (id: string) => void | Promise<void>;
  shellCleanup?: (context: ShellContext) => void | Promise<void>;

  async mountNode(
    surface: CompiledPlayableSurface,
    context: NodeContext,
  ): Promise<PlayableMountedSurface> {
    this.events.push(`mount:${surface.id}`);
    this.nodeContexts.push({ id: surface.id, context });
    await this.onMountNode?.(surface, context);
    return {
      cleanup: () => {
        this.events.push(`cleanup:${surface.id}`);
        return this.nodeCleanup?.(surface.id, context);
      },
      destroy: () => {
        this.events.push(`destroy:${surface.id}`);
        return this.nodeDestroy?.(surface.id);
      },
    };
  }

  async mountShell(
    surface: CompiledPlayableSurface,
    context: ShellContext,
  ): Promise<PlayableMountedSurface> {
    this.events.push(`mount:${surface.id}`);
    this.shellContexts.push(context);
    await this.onMountShell?.(surface, context);
    return {
      cleanup: () => {
        this.events.push(`cleanup:${surface.id}`);
        return this.shellCleanup?.(context);
      },
      destroy: () => {
        this.events.push(`destroy:${surface.id}`);
      },
    };
  }
}

describe("Node Runtime", () => {
  it("mounts the persistent Shell once and replaces the current Node", async () => {
    const { runtime, host } = createRuntime();

    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");

    expect(host.events).toEqual([
      "mount:shell",
      "mount:menu",
      "cleanup:menu",
      "destroy:menu",
      "mount:lobby",
    ]);
    expect(host.shellContexts).toHaveLength(1);
    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "lobby",
      backStack: [],
      recentSignals: [
        expect.objectContaining({
          nodeId: "menu",
          signal: "start",
          targetNodeId: "lobby",
        }),
      ],
      save: { present: true, savedAt: expect.any(String) },
    });
  });

  it("supports push, back, and Shell Signals without remounting the Shell", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("inspect");
    expect(runtime.snapshot().backStack).toEqual(["menu"]);
    await nodeContext(host, "archive").navigation.back();
    await shellContext(host).navigation.emit("archive");

    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "archive",
      backStack: [],
    });
    expect(host.shellContexts).toHaveLength(1);
    expect(host.nodeContexts.map(({ id }) => id)).toEqual([
      "menu",
      "archive",
      "menu",
      "archive",
    ]);
  });

  it("aborts lifecycle before cleanup and invalidates an exited context", async () => {
    const { runtime, host } = createRuntime();
    const cleanupSignals: boolean[] = [];
    host.nodeCleanup = (_id, context) => {
      cleanupSignals.push(context.lifecycle.signal.aborted);
    };
    await runtime.start();
    const menu = nodeContext(host, "menu");

    await menu.navigation.emit("start");

    expect(cleanupSignals).toEqual([true]);
    await expect(menu.state.set("hasKey", true)).rejects.toMatchObject({
      code: "stale-surface",
    });
  });

  it("rejects navigation while a surface is mounting", async () => {
    const host = new FakeSurfaceHost();
    let nodeNavigation: Promise<void> | undefined;
    let shellNavigation: Promise<void> | undefined;
    host.onMountNode = (_surface, context) => {
      nodeNavigation = context.navigation.emit("start");
    };
    host.onMountShell = (_surface, context) => {
      shellNavigation = context.navigation.emit("archive");
    };
    const { runtime } = createRuntime({ host });

    await runtime.start();

    await expect(nodeNavigation).rejects.toMatchObject({
      code: "navigation-in-progress",
    });
    await expect(shellNavigation).rejects.toMatchObject({
      code: "navigation-in-progress",
    });
    expect(runtime.snapshot().currentNodeId).toBe("menu");
  });

  it("rejects concurrent navigation from the persistent Shell", async () => {
    const host = new FakeSurfaceHost();
    let releaseArchive!: () => void;
    const archiveMounted = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    host.onMountNode = async (surface) => {
      if (surface.id === "archive") await archiveMounted;
    };
    const { runtime } = createRuntime({ host });
    await runtime.start();

    const first = shellContext(host).navigation.emit("archive");
    await expect(
      shellContext(host).navigation.emit("home"),
    ).rejects.toMatchObject({ code: "navigation-in-progress" });
    releaseArchive();
    await first;
  });

  it("rejects concurrent starts before save loading finishes", async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { runtime } = createRuntime({
      saveStore: {
        async load() {
          await loadGate;
          return undefined;
        },
        async save() {},
      },
    });

    const first = runtime.start();
    await expect(runtime.start()).rejects.toMatchObject({
      code: "already-started",
    });
    releaseLoad();
    await first;
  });

  it("cancels startup cleanly when disposed during save loading", async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { runtime, host } = createRuntime({
      saveStore: {
        async load() {
          await loadGate;
          return undefined;
        },
        async save() {},
      },
    });

    const start = runtime.start();
    const disposal = runtime.dispose();
    releaseLoad();

    await expect(start).rejects.toMatchObject({ code: "disposed" });
    await disposal;
    expect(host.events).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({ status: "disposed" });
  });

  it("disposes a Node that finishes mounting after disposal begins", async () => {
    const host = new FakeSurfaceHost();
    let releaseArchive!: () => void;
    let archiveStarted!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const mountingArchive = new Promise<void>((resolve) => {
      archiveStarted = resolve;
    });
    host.onMountNode = async (surface) => {
      if (surface.id !== "archive") return;
      archiveStarted();
      await archiveGate;
    };
    const { runtime } = createRuntime({ host });
    await runtime.start();

    const navigation = shellContext(host).navigation.emit("archive");
    await mountingArchive;
    const disposal = runtime.dispose();
    releaseArchive();

    await expect(navigation).rejects.toMatchObject({ code: "disposed" });
    await disposal;
    expect(host.events).toEqual([
      "mount:shell",
      "mount:menu",
      "cleanup:menu",
      "destroy:menu",
      "mount:archive",
      "cleanup:archive",
      "destroy:archive",
      "cleanup:shell",
      "destroy:shell",
    ]);
  });

  it("enters a cleaned failed state when a navigation target cannot mount", async () => {
    const host = new FakeSurfaceHost();
    host.onMountNode = (surface) => {
      if (surface.id === "archive") throw new Error("archive mount failed");
    };
    const { runtime } = createRuntime({ host });
    await runtime.start();
    const shell = shellContext(host);

    await expect(shell.navigation.emit("archive")).rejects.toThrow(
      "archive mount failed",
    );

    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "archive",
      status: "failed",
    });
    expect(host.events).toEqual([
      "mount:shell",
      "mount:menu",
      "cleanup:menu",
      "destroy:menu",
      "mount:archive",
      "cleanup:shell",
      "destroy:shell",
    ]);
    expect(() => shell.state.get()).toThrowError(
      expect.objectContaining({ code: "runtime-failed" }),
    );
    await expect(runtime.start()).rejects.toMatchObject({
      code: "runtime-failed",
    });
  });

  it("fails cleanly when continue restores State but its saved Node cannot mount", async () => {
    const host = new FakeSurfaceHost();
    host.onMountNode = (surface) => {
      if (surface.id === "archive") throw new Error("saved Node failed");
    };
    const saved = createSave({
      currentNodeId: "archive",
      state: { hasKey: true, clues: ["ledger"], profile: { name: "Ada" } },
    });
    const { runtime } = createRuntime({
      host,
      saveStore: new MemoryPlayableSaveStore(saved),
    });
    await runtime.start();

    await expect(nodeContext(host, "menu").session.continue()).rejects.toThrow(
      "saved Node failed",
    );

    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "archive",
      state: saved.state,
      status: "failed",
    });
  });

  it("owns cloned State, notifies subscribers, and removes Node listeners on exit", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();
    const menu = nodeContext(host, "menu");
    const received: unknown[] = [];
    menu.state.subscribe((state) => received.push(state));

    const state = menu.state.get();
    (state.profile as { name: string }).name = "mutated outside";
    await menu.state.patch({
      hasKey: true,
      profile: { name: "Ada" },
    });
    await menu.navigation.emit("start");
    await nodeContext(host, "lobby").state.set("hasKey", false);

    expect(received).toEqual([
      expect.objectContaining({ hasKey: true, profile: { name: "Ada" } }),
    ]);
    expect(runtime.snapshot().state).toMatchObject({
      hasKey: false,
      profile: { name: "Ada" },
    });
    expect(() => nodeContext(host, "lobby").state.get("missing")).toThrowError(
      expect.objectContaining({ code: "unknown-state-key" }),
    );
  });

  it("limits each surface to its declared assets", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();

    expect(nodeContext(host, "menu").assets.url("background")).toBe(
      "asset://background",
    );
    expect(() => nodeContext(host, "menu").assets.url("theme")).toThrowError(
      expect.objectContaining({ code: "undeclared-asset" }),
    );
    expect(shellContext(host).assets.url("theme")).toBe("asset://theme");

    const missing = createRuntime({ assetUrls: {} });
    await missing.runtime.start();
    expect(() =>
      nodeContext(missing.host, "menu").assets.url("background"),
    ).toThrowError(expect.objectContaining({ code: "missing-asset-url" }));
  });

  it("checkpoints State and navigation writes in order", async () => {
    const saves: PlayableSave[] = [];
    const releases: Array<() => void> = [];
    const store: PlayableSaveStore = {
      async load() {
        return undefined;
      },
      async save(save) {
        saves.push(structuredClone(save));
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    };
    const { runtime, host } = createRuntime({ saveStore: store });
    await runtime.start();
    const menu = nodeContext(host, "menu");

    const first = menu.state.set("hasKey", true);
    const second = menu.state.set("hasKey", false);
    await Promise.resolve();
    expect(saves).toHaveLength(1);
    releases.shift()!();
    await first;
    await Promise.resolve();
    expect(saves).toHaveLength(2);
    releases.shift()!();
    await second;

    expect(saves.map((save) => save.state.hasKey)).toEqual([true, false]);
  });

  it("continues a compatible save and ignores an incompatible one", async () => {
    const saved = createSave({
      currentNodeId: "archive",
      backStack: ["menu"],
      state: { hasKey: true, clues: ["ledger"], profile: { name: "Ada" } },
    });
    const restored = createRuntime({
      saveStore: new MemoryPlayableSaveStore(saved),
    });
    await restored.runtime.start();
    expect(restored.runtime.snapshot().save.present).toBe(true);

    await nodeContext(restored.host, "menu").session.continue();
    expect(restored.runtime.snapshot()).toMatchObject({
      currentNodeId: "archive",
      backStack: ["menu"],
      state: saved.state,
    });

    const incompatible = createRuntime({
      saveStore: new MemoryPlayableSaveStore({
        ...saved,
        graphSignature: "different",
      }),
    });
    await incompatible.runtime.start();
    expect(incompatible.runtime.snapshot().save.present).toBe(false);
    await expect(
      nodeContext(incompatible.host, "menu").session.continue(),
    ).rejects.toMatchObject({ code: "no-save" });
  });

  it("resets in place and restarts at the Entry Node", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();
    const menu = nodeContext(host, "menu");
    await menu.state.set("hasKey", true);
    await menu.navigation.emit("inspect");
    const archive = nodeContext(host, "archive");

    await archive.session.reset();
    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "archive",
      backStack: [],
      state: createNodeGraphFixture().initialState,
    });
    expect(host.nodeContexts.map(({ id }) => id)).toEqual(["menu", "archive"]);

    await archive.session.restart();
    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "menu",
      backStack: [],
      state: createNodeGraphFixture().initialState,
    });
  });

  it("reports listener and cleanup failures without breaking transitions", async () => {
    const errors: unknown[] = [];
    const host = new FakeSurfaceHost();
    host.nodeCleanup = () => {
      throw new Error("cleanup failed");
    };
    host.nodeDestroy = () => {
      throw new Error("destroy failed");
    };
    const { runtime } = createRuntime({
      host,
      onError: (error) => errors.push(error),
    });
    await runtime.start();
    const menu = nodeContext(host, "menu");
    menu.state.subscribe(() => {
      throw new Error("listener failed");
    });

    await menu.state.set("hasKey", true);
    await menu.navigation.emit("start");

    expect(runtime.snapshot().currentNodeId).toBe("lobby");
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "listener failed",
      "cleanup failed",
      "destroy failed",
    ]);
  });

  it("rejects invalid cleanup values and invalid save timestamps", async () => {
    const invalidHost = new FakeSurfaceHost();
    invalidHost.mountNode = async () =>
      ({
        cleanup: "not a function",
        destroy() {},
      }) as unknown as PlayableMountedSurface;
    const invalidMount = createRuntime({ host: invalidHost });
    await expect(invalidMount.runtime.start()).rejects.toMatchObject({
      code: "invalid-cleanup",
    });

    const invalidSave = createRuntime({
      saveStore: new MemoryPlayableSaveStore(
        createSave({ savedAt: "not-a-date" }),
      ),
    });
    await invalidSave.runtime.start();
    expect(invalidSave.runtime.snapshot().save.present).toBe(false);
  });
});


describe("NodeRuntime preview tooling", () => {
  it("reports Signals under the report policy without leaving the Node", async () => {
    const { runtime, host } = createRuntime({ policy: "report" });
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("start");
    await nodeContext(host, "menu").navigation.back();
    await shellContext(host).navigation.emit("archive");

    expect(host.events).toEqual(["mount:shell", "mount:menu"]);
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      status: "running",
      policy: "report",
      currentNodeId: "menu",
      backStack: [],
    });
    expect(snapshot.recentSignals).toEqual([
      expect.objectContaining({ nodeId: "menu", signal: "start", targetNodeId: "lobby" }),
      expect.objectContaining({ nodeId: "shell", signal: "archive", targetNodeId: "archive" }),
    ]);
    expect(snapshot.reports).toEqual([
      expect.objectContaining({ kind: "signal", signal: "start", targetNodeId: "lobby" }),
      { kind: "back", nodeId: "menu", at: "2026-09-28T00:00:00.000Z" },
      expect.objectContaining({ kind: "signal", nodeId: "shell", signal: "archive", edgeId: "shell-archive", targetNodeId: "archive", mode: "replace" }),
    ]);
  });

  it("still rejects undeclared Signals under the report policy and records the error", async () => {
    const { runtime, host } = createRuntime({ policy: "report" });
    await runtime.start();

    await expect(
      nodeContext(host, "menu").navigation.emit("missing"),
    ).rejects.toMatchObject({ code: "unknown-signal" });
    expect(runtime.snapshot().errors).toEqual([
      expect.objectContaining({ nodeId: "menu", code: "unknown-signal" }),
    ]);
  });

  it("starts at a chosen Node with validated preview State", async () => {
    const { runtime, host } = createRuntime({
      startNodeId: "archive",
      previewState: { hasKey: true },
    });
    await runtime.start();

    expect(host.events).toEqual(["mount:shell", "mount:archive"]);
    expect(runtime.snapshot().state).toEqual({
      hasKey: true,
      clues: [],
      profile: { name: "" },
    });
    expect(() => createRuntime({ previewState: { unknown: 1 } })).toThrowError(
      expect.objectContaining({ code: "unknown-state-key" }),
    );
    expect(() => createRuntime({ startNodeId: "nowhere" })).toThrowError(
      expect.objectContaining({ code: "unknown-node" }),
    );
  });

  it("records State reads and writes per surface", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();
    const menu = nodeContext(host, "menu");

    menu.state.get("hasKey");
    await menu.state.patch({ clues: ["ledger"] });
    shellContext(host).state.get();

    expect(runtime.snapshot().stateAccess).toEqual({
      menu: { read: ["hasKey"], wrote: ["clues"] },
      shell: { read: ["*"], wrote: [] },
    });
    expect(() => menu.state.get("missing" as "hasKey")).toThrow();
    expect(runtime.snapshot().errors).toEqual([
      expect.objectContaining({ nodeId: "menu", code: "unknown-state-key" }),
    ]);
  });
});

function createRuntime(
  options: {
    host?: FakeSurfaceHost;
    saveStore?: PlayableSaveStore;
    assetUrls?: Record<string, string>;
    onError?: (error: unknown) => void;
    policy?: NodeRuntimeOptions["policy"];
    startNodeId?: string;
    previewState?: NodeRuntimeOptions["previewState"];
  } = {},
): {
  runtime: NodeRuntime;
  host: FakeSurfaceHost;
} {
  const graph = createNodeGraphFixture();
  const host = options.host ?? new FakeSurfaceHost();
  return {
    host,
    runtime: new NodeRuntime({
      graph,
      compiled: createCompiledGraph(),
      graphSignature: "fixture-v1",
      surfaceHost: host,
      saveStore: options.saveStore ?? new MemoryPlayableSaveStore(),
      assetUrls: options.assetUrls ?? {
        background: "asset://background",
        theme: "asset://theme",
      },
      now: () => new Date("2026-09-28T00:00:00.000Z"),
      onError: options.onError,
      policy: options.policy,
      startNodeId: options.startNodeId,
      previewState: options.previewState,
    }),
  };
}

function createCompiledGraph(): CompiledNodeGraph {
  const surface = (id: string): CompiledPlayableSurface => ({
    id,
    html: "",
    css: "",
    javascript: "export function mount() {}",
    inputs: [],
  });
  return {
    version: 1,
    nodes: {
      menu: surface("menu"),
      lobby: surface("lobby"),
      archive: surface("archive"),
    },
    shell: surface("shell"),
  };
}

function nodeContext(host: FakeSurfaceHost, id: string): NodeContext {
  const entry = [...host.nodeContexts]
    .reverse()
    .find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Node "${id}" was not mounted.`);
  return entry.context;
}

function shellContext(host: FakeSurfaceHost): ShellContext {
  const context = host.shellContexts.at(-1);
  if (!context) throw new Error("Shell was not mounted.");
  return context;
}

function createSave(overrides: Partial<PlayableSave> = {}): PlayableSave {
  return {
    version: 1,
    graphVersion: 1,
    graphSignature: "fixture-v1",
    savedAt: "2026-09-27T00:00:00.000Z",
    currentNodeId: "menu",
    backStack: [],
    state: createNodeGraphFixture().initialState,
    ...overrides,
  };
}
