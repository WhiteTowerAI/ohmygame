import { describe, expect, it } from "vitest";
import type {
  CompiledNodeGraph,
  CompiledPlayableSurface,
} from "../src/shared/playable-compiled.js";
import type { NodeGraph, PlayableNodeContext } from "../src/shared/playable-nodes.js";
import {
  MemoryPlayablePreferencesStore,
  MemoryPlayableSaveStore,
  MemoryPlayableSeenStore,
  MemoryPlayableSlotStore,
  NodeRuntime,
  type NodeRuntimeOptions,
  type PlayableAudioHost,
  type PlayableMountedSurface,
  type PlayablePreferencesStore,
  type PlayableSave,
  type PlayableSaveStore,
  type PlayableSeenStore,
  type PlayableSlotStore,
  type PlayableSurfaceHost,
} from "../src/shared/playable-runtime.js";
import type { PlayableSeen } from "../src/shared/playable-story-map.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

type NodeContext = Omit<PlayableNodeContext, "root">;

class FakeSurfaceHost implements PlayableSurfaceHost {
  readonly events: string[] = [];
  readonly nodeContexts: Array<{ id: string; context: NodeContext }> = [];
  onMountNode?: (
    surface: CompiledPlayableSurface,
    context: NodeContext,
  ) => void | Promise<void>;
  nodeCleanup?: (id: string, context: NodeContext) => void | Promise<void>;
  nodeDestroy?: (id: string) => void | Promise<void>;

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
}

describe("Node Runtime", () => {
  it("mounts the Entry Node and replaces the current Node", async () => {
    const { runtime, host } = createRuntime();

    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");

    expect(host.events).toEqual([
      "mount:menu",
      "mount:lobby",
      "cleanup:menu",
      "destroy:menu",
    ]);
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

  it("supports push and back", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("inspect");
    expect(runtime.snapshot().backStack).toEqual(["menu"]);
    await nodeContext(host, "archive").navigation.back();

    expect(runtime.snapshot()).toMatchObject({ currentNodeId: "menu", backStack: [] });
    expect(host.nodeContexts.map(({ id }) => id)).toEqual(["menu", "archive", "menu"]);
  });

  it("routes a shared component's Signal as the Signal of the Scene that shows it", async () => {
    const { runtime, host } = createRuntime({ startNodeId: "lobby" });
    await runtime.start();

    // The shared top bar emits through the lobby's own context.
    await nodeContext(host, "lobby").navigation.emit("archive");
    await expect(nodeContext(host, "archive").navigation.emit("archive")).rejects.toMatchObject({
      code: "unknown-signal",
    });
    await nodeContext(host, "archive").navigation.emit("home");

    const snapshot = runtime.snapshot();
    expect(snapshot.currentNodeId).toBe("menu");
    expect(snapshot.recentSignals).toEqual([
      expect.objectContaining({ nodeId: "lobby", signal: "archive", targetNodeId: "archive" }),
      expect.objectContaining({ nodeId: "archive", signal: "home", targetNodeId: "menu" }),
    ]);
    expect(snapshot.errors).toEqual([
      expect.objectContaining({ nodeId: "archive", code: "unknown-signal" }),
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
    host.onMountNode = (_surface, context) => {
      nodeNavigation = context.navigation.emit("start");
    };
    const { runtime } = createRuntime({ host });

    await runtime.start();

    await expect(nodeNavigation).rejects.toMatchObject({
      code: "navigation-in-progress",
    });
    expect(runtime.snapshot().currentNodeId).toBe("menu");
  });

  it("rejects a second navigation from a Node that is already leaving", async () => {
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

    const menu = nodeContext(host, "menu");
    const first = menu.navigation.emit("inspect");
    await expect(
      menu.navigation.emit("start"),
    ).rejects.toMatchObject({ code: "stale-surface" });
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

    const navigation = nodeContext(host, "menu").navigation.emit("inspect");
    await mountingArchive;
    const disposal = runtime.dispose();
    releaseArchive();

    await expect(navigation).rejects.toMatchObject({ code: "disposed" });
    await disposal;
    expect(host.events).toEqual([
      "mount:menu",
      "mount:archive",
      "cleanup:menu",
      "destroy:menu",
      "cleanup:archive",
      "destroy:archive",
    ]);
  });

  it("enters a cleaned failed state when a navigation target cannot mount", async () => {
    const host = new FakeSurfaceHost();
    host.onMountNode = (surface) => {
      if (surface.id === "archive") throw new Error("archive mount failed");
    };
    const { runtime } = createRuntime({ host });
    await runtime.start();
    await expect(nodeContext(host, "menu").navigation.emit("inspect")).rejects.toThrow(
      "archive mount failed",
    );

    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "archive",
      status: "failed",
    });
    expect(host.events).toEqual([
      "mount:menu",
      "mount:archive",
      "cleanup:menu",
      "destroy:menu",
    ]);
    expect(() => nodeContext(host, "archive").state.get()).toThrowError(
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
    await nodeContext(host, "menu").navigation.emit("start");
    expect(nodeContext(host, "lobby").assets.url("theme")).toBe("asset://theme");

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
    expect(incompatible.runtime.snapshot().save).toEqual({ present: false, incompatible: true });
    await expect(
      nodeContext(incompatible.host, "menu").session.continue(),
    ).rejects.toMatchObject({ code: "no-save" });
  });

  it("keeps the save where the player left the story when they go Home", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");
    await nodeContext(host, "lobby").state.set("hasKey", true);

    await nodeContext(host, "lobby").navigation.emit("home");
    expect(runtime.snapshot()).toMatchObject({ currentNodeId: "menu", state: { hasKey: true } });
    await nodeContext(host, "menu").session.continue();

    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "lobby",
      backStack: [],
      state: { hasKey: true },
    });
  });

  it("keeps a saved game when the player goes around the game from the menu and Back", async () => {
    const saved = createSave({
      currentNodeId: "lobby",
      state: { hasKey: true, clues: ["ledger"], profile: { name: "Ada" } },
    });
    const saveStore = new MemoryPlayableSaveStore(saved);
    // The archive is a side screen of the menu, as a Story map is.
    const { runtime, host } = createRuntime({ saveStore, graph: createGraphWithArchiveAside() });
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("inspect");
    await nodeContext(host, "archive").navigation.back();
    expect(await saveStore.load()).toEqual(saved);
    expect(nodeContext(host, "menu").session.hasSave()).toBe(true);
    await nodeContext(host, "menu").session.continue();

    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "lobby",
      backStack: [],
      state: saved.state,
    });
  });

  it("offers nothing to continue after only going around the game", async () => {
    const { runtime, host } = createRuntime({ graph: createGraphWithArchiveAside() });
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("inspect");
    await nodeContext(host, "archive").navigation.back();

    expect(nodeContext(host, "menu").session.hasSave()).toBe(false);
    expect(runtime.snapshot().save).toEqual({ present: false });
  });

  it("checkpoints Back from a step in the story, and Back past where the player left it", async () => {
    const saveStore = new MemoryPlayableSaveStore();
    const { runtime, host } = createRuntime({ saveStore });
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("inspect");
    await nodeContext(host, "archive").navigation.back();
    expect(await saveStore.load()).toMatchObject({ currentNodeId: "menu", backStack: [] });

    await nodeContext(host, "menu").navigation.emit("inspect");
    await nodeContext(host, "archive").navigation.emit("home");
    expect(await saveStore.load()).toMatchObject({ currentNodeId: "archive", backStack: ["menu"] });
    await nodeContext(host, "menu").navigation.back();

    expect(runtime.snapshot()).toMatchObject({ currentNodeId: "menu", backStack: [] });
    expect(await saveStore.load()).toMatchObject({ currentNodeId: "menu", backStack: [] });
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


describe("Node Runtime connected Signals", () => {
  it("tells a Node which of its Signals go somewhere", async () => {
    const host = new FakeSurfaceHost();
    const { runtime } = createRuntime({ host });
    await runtime.start();
    const menu = nodeContext(host, "menu");

    expect(menu.navigation.connected("start")).toBe(true);
    expect(menu.navigation.connected("missing")).toBe(false);
    await menu.navigation.emit("start");
    // Another Node's Signal is not this one's, even with an edge.
    expect(nodeContext(host, "lobby").navigation.connected("start")).toBe(false);
    expect(() => menu.navigation.connected("start")).toThrowError(expect.objectContaining({ code: "stale-surface" }));
  });
});

describe("Node Runtime Story Map", () => {
  it("remembers the Nodes entered and edges taken, and maps them", async () => {
    const seenStore = new MemoryPlayableSeenStore();
    const { runtime, host } = createRuntime({ seenStore });
    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");
    expect(nodeContext(host, "menu").story.seenBefore).toBe(false);
    expect(nodeContext(host, "lobby").story.seenBefore).toBe(false);

    const map = nodeContext(host, "lobby").story.map();
    expect(map.nodes.map((node) => [node.id, node.row, node.seen, node.ending])).toEqual([
      ["menu", 0, true, false],
      ["lobby", 1, true, false],
      ["archive", 2, false, true],
    ]);
    expect(map.edges).toEqual([
      { from: "menu", to: "lobby", seen: true },
      { from: "lobby", to: "archive", seen: false },
    ]);
    await runtime.dispose();
    expect(await seenStore.load()).toEqual({
      version: 1,
      nodes: { menu: "2026-09-28T00:00:00.000Z", lobby: "2026-09-28T00:00:00.000Z" },
      edges: { "start-game": "2026-09-28T00:00:00.000Z" },
    });
  });

  it("keeps what was seen when a new game starts", async () => {
    const seenStore = new MemoryPlayableSeenStore(seenRecord(["menu", "lobby", "archive"]));
    const { runtime, host } = createRuntime({ seenStore });
    await runtime.start();
    await nodeContext(host, "menu").session.restart();

    expect(nodeContext(host, "menu").story.map().nodes.every((node) => node.seen)).toBe(true);
    // A Scene can offer to skip what the player saw in an earlier game.
    expect(nodeContext(host, "menu").story.seenBefore).toBe(true);
  });

  it("tells a Node it was seen before only on a later visit in the same game", async () => {
    const { runtime, host } = createRuntime({ seenStore: new MemoryPlayableSeenStore() });
    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");
    await nodeContext(host, "lobby").navigation.emit("home");
    expect(host.nodeContexts.filter((entry) => entry.id === "menu").map((entry) => entry.context.story.seenBefore))
      .toEqual([false, true]);
  });

  it("shows the whole map in a preview without adding to what was seen", async () => {
    const saved: PlayableSeen[] = [];
    const seenStore: PlayableSeenStore = {
      load: async () => seenRecord(["menu"]),
      save: async (seen) => { saved.push(seen); },
    };
    const { runtime, host } = createRuntime({ seenStore, policy: "report", startNodeId: "lobby" });
    await runtime.start();
    await nodeContext(host, "lobby").navigation.emit("archive");

    const map = nodeContext(host, "lobby").story.map();
    expect(map.nodes.every((node) => node.seen) && map.edges.every((edge) => edge.seen)).toBe(true);
    await runtime.dispose();
    expect(saved).toEqual([]);

    // A preview plays a Scene as it first appears, without Skip.
    const preview = createRuntime({ seenStore, policy: "report", startNodeId: "menu" });
    await preview.runtime.start();
    expect(nodeContext(preview.host, "menu").story.seenBefore).toBe(false);
  });

  it("plays on when what was seen cannot be read or kept", async () => {
    const errors: unknown[] = [];
    const seenStore: PlayableSeenStore = {
      load: async () => { throw new Error("storage is unavailable"); },
      save: async () => { throw new Error("storage is full"); },
    };
    const { runtime, host } = createRuntime({ seenStore, onError: (error) => errors.push(error) });
    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");
    await runtime.dispose();

    expect(runtime.snapshot().errors.map((error) => error.message)).toEqual([
      "storage is unavailable",
      "storage is full",
    ]);
    expect(errors).toHaveLength(2);
  });
});

/** Records what the Runtime asks the sandbox to play. */
class FakeAudio implements PlayableAudioHost {
  readonly calls: string[] = [];
  music(url: string | undefined, fade: number) { this.calls.push(`music:${url ?? "none"}:${fade}`); }
  sound(url: string) { this.calls.push(`sound:${url}`); }
  volumes(volumes: { music: number; sound: number }) { this.calls.push(`volumes:${volumes.music}:${volumes.sound}`); }
}

describe("Node Runtime positions", () => {
  it("keeps a Node's position on the back stack and in the save, and starts a Node entered by a Signal afresh", async () => {
    const saveStore = new MemoryPlayableSaveStore();
    const { runtime, host } = createRuntime({ saveStore });
    await runtime.start();
    const menu = nodeContext(host, "menu");
    expect(menu.position.get()).toBeNull();
    await menu.position.set({ line: 3 });
    expect(await saveStore.load()).toMatchObject({ currentNodeId: "menu", position: { line: 3 } });

    await menu.navigation.emit("inspect");
    expect(nodeContext(host, "archive").position.get()).toBeNull();
    await nodeContext(host, "archive").position.set("page-2");
    expect(await saveStore.load()).toMatchObject({ position: "page-2", backPositions: [{ line: 3 }] });

    await nodeContext(host, "archive").navigation.back();
    expect(nodeContext(host, "menu").position.get()).toEqual({ line: 3 });
    expect(runtime.snapshot().position).toEqual({ line: 3 });

    await nodeContext(host, "menu").navigation.emit("start");
    expect(nodeContext(host, "lobby").position.get()).toBeNull();
    await expect(nodeContext(host, "lobby").position.set({ big: "x".repeat(70_000) })).rejects.toMatchObject({ code: "invalid-position" });
  });

  it("continues at the saved position, and continues saves from before positions at the Node's start", async () => {
    const restored = createRuntime({
      saveStore: new MemoryPlayableSaveStore(createSave({
        currentNodeId: "archive",
        backStack: ["menu"],
        position: { line: 12 },
        backPositions: [{ entry: 2 }],
      })),
    });
    await restored.runtime.start();
    await nodeContext(restored.host, "menu").session.continue();
    expect(nodeContext(restored.host, "archive").position.get()).toEqual({ line: 12 });
    await nodeContext(restored.host, "archive").navigation.back();
    expect(nodeContext(restored.host, "menu").position.get()).toEqual({ entry: 2 });

    // An older save, or back positions that do not match the back stack, still continue.
    const older = createRuntime({
      saveStore: new MemoryPlayableSaveStore({ ...createSave({ currentNodeId: "archive", backStack: ["menu"] }), backPositions: [] }),
    });
    await older.runtime.start();
    await nodeContext(older.host, "menu").session.continue();
    expect(nodeContext(older.host, "archive").position.get()).toBeNull();
    await nodeContext(older.host, "archive").navigation.back();
    expect(nodeContext(older.host, "menu").position.get()).toBeNull();
  });

  it("clears positions on a new game", async () => {
    const { runtime, host } = createRuntime();
    await runtime.start();
    await nodeContext(host, "menu").position.set(1);
    await nodeContext(host, "menu").session.reset();
    expect(nodeContext(host, "menu").position.get()).toBeNull();
    await nodeContext(host, "menu").position.set(2);
    await nodeContext(host, "menu").session.restart();
    expect(nodeContext(host, "menu").position.get()).toBeNull();
    expect(runtime.snapshot().position).toBeNull();
  });
});

describe("Node Runtime music and sound", () => {
  it("plays music on across Nodes, keeps it in the save, and stops it on a new game", async () => {
    const audio = new FakeAudio();
    const saveStore = new MemoryPlayableSaveStore();
    const { runtime, host } = createRuntime({ audio, saveStore });
    await runtime.start();
    expect(audio.calls).toEqual(["volumes:0.7:1"]);
    // Music is an Asset the Node declares.
    expect(() => nodeContext(host, "menu").audio.music("theme")).toThrow('Asset "theme" is not declared');

    await nodeContext(host, "menu").navigation.emit("start");
    const lobby = nodeContext(host, "lobby");
    lobby.audio.music("theme", { fade: 2 });
    lobby.audio.music("theme");
    lobby.audio.sound("theme");
    expect(audio.calls.slice(1)).toEqual(["music:asset://theme:2", "sound:asset://theme"]);
    expect(() => lobby.audio.music("theme", { fade: -1 })).toThrow("Music fade");
    expect(runtime.snapshot().music).toBe("theme");

    await lobby.navigation.emit("archive");
    expect(runtime.snapshot().music).toBe("theme");
    expect(await saveStore.load()).toMatchObject({ currentNodeId: "archive", music: "theme" });

    await nodeContext(host, "archive").session.restart();
    expect(audio.calls.at(-1)).toBe("music:none:1");
    expect(runtime.snapshot().music).toBeUndefined();
  });

  it("stops music with null", async () => {
    const audio = new FakeAudio();
    const { runtime, host } = createRuntime({ audio, startNodeId: "lobby" });
    await runtime.start();
    const lobby = nodeContext(host, "lobby");
    lobby.audio.music("theme");
    lobby.audio.music(null, { fade: 0 });
    expect(audio.calls.slice(1)).toEqual(["music:asset://theme:1", "music:none:0"]);
  });

  it("restores the saved music on Continue and ignores music the graph no longer has", async () => {
    const audio = new FakeAudio();
    const { runtime, host } = createRuntime({
      audio,
      saveStore: new MemoryPlayableSaveStore(createSave({ currentNodeId: "lobby", music: "theme" })),
    });
    await runtime.start();
    await nodeContext(host, "menu").session.continue();
    expect(runtime.snapshot().music).toBe("theme");
    expect(audio.calls.at(-1)).toBe("music:asset://theme:1");

    const missing = createRuntime({
      audio: new FakeAudio(),
      saveStore: new MemoryPlayableSaveStore(createSave({ currentNodeId: "lobby", music: "gone" })),
    });
    await missing.runtime.start();
    await nodeContext(missing.host, "menu").session.continue();
    expect(missing.runtime.snapshot().music).toBeUndefined();
  });
});

describe("Node Runtime preferences", () => {
  it("gives defaults, keeps changes apart from saves, and sets the volumes", async () => {
    const audio = new FakeAudio();
    const preferencesStore = new MemoryPlayablePreferencesStore({ textSpeed: 30 });
    const { runtime, host } = createRuntime({ audio, preferencesStore });
    await runtime.start();
    const menu = nodeContext(host, "menu");
    expect(menu.preferences.get()).toEqual({ musicVolume: 0.7, soundVolume: 1, textSpeed: 30 });

    await menu.preferences.set({ musicVolume: 0.2 });
    expect(audio.calls.at(-1)).toBe("volumes:0.2:1");
    expect(await preferencesStore.load()).toEqual({ textSpeed: 30, musicVolume: 0.2 });

    await menu.session.restart();
    expect(nodeContext(host, "menu").preferences.get()).toMatchObject({ musicVolume: 0.2, textSpeed: 30 });
    await expect(nodeContext(host, "menu").preferences.set({ soundVolume: 2 })).rejects.toMatchObject({ code: "invalid-preferences" });
  });

  it("starts over from settings that cannot be read", async () => {
    const { runtime, host } = createRuntime({
      preferencesStore: new MemoryPlayablePreferencesStore({ musicVolume: "loud" }),
    });
    await runtime.start();
    expect(nodeContext(host, "menu").preferences.get()).toEqual({ musicVolume: 0.7, soundVolume: 1 });
  });
});

describe("Node Runtime save slots", () => {
  it("saves a game in a slot with a note and loads it with its position and music", async () => {
    const slotStore = new MemoryPlayableSlotStore();
    const { runtime, host } = createRuntime({ slotStore, startNodeId: "lobby" });
    await runtime.start();
    const lobby = nodeContext(host, "lobby");
    await lobby.state.set("hasKey", true);
    await lobby.position.set({ line: 7 });
    lobby.audio.music("theme");
    await lobby.session.saveSlot("1", "Mio: You came alone.");
    expect(lobby.session.slots()).toEqual([
      { id: "1", savedAt: "2026-09-28T00:00:00.000Z", nodeId: "lobby", note: "Mio: You came alone." },
    ]);

    await lobby.session.restart();
    expect(runtime.snapshot()).toMatchObject({ currentNodeId: "menu", state: { hasKey: false } });

    await nodeContext(host, "menu").session.loadSlot("1");
    expect(runtime.snapshot()).toMatchObject({ currentNodeId: "lobby", state: { hasKey: true }, position: { line: 7 }, music: "theme" });
    // Loading a slot also moves the save there, so Continue picks up from it.
    expect(runtime.snapshot().save.present).toBe(true);

    // Slots outlast the session.
    const later = createRuntime({ slotStore });
    await later.runtime.start();
    expect(nodeContext(later.host, "menu").session.slots().map((slot) => slot.id)).toEqual(["1"]);
  });

  it("lists another version's slot without loading it, keeps it when saving others, and deletes slots", async () => {
    const slotStore = new MemoryPlayableSlotStore({
      2: { save: createSave({ graphSignature: "older", currentNodeId: "archive" }), note: "Old" },
      "bad slot": { save: createSave() },
    });
    const { runtime, host } = createRuntime({ slotStore });
    await runtime.start();
    const menu = nodeContext(host, "menu");
    expect(menu.session.slots()).toEqual([
      { id: "2", savedAt: "2026-09-27T00:00:00.000Z", nodeId: "archive", note: "Old", incompatible: true },
    ]);
    await expect(menu.session.loadSlot("2")).rejects.toMatchObject({ code: "no-save" });
    await expect(menu.session.loadSlot("3")).rejects.toMatchObject({ code: "no-save" });
    await expect(menu.session.saveSlot("bad slot")).rejects.toMatchObject({ code: "invalid-slot" });
    await expect(menu.session.saveSlot("4", "x".repeat(201))).rejects.toMatchObject({ code: "invalid-slot" });

    await menu.session.saveSlot("10");
    expect(Object.keys((await slotStore.load()) as object).sort()).toEqual(["10", "2", "bad slot"]);
    expect(menu.session.slots().map((slot) => slot.id)).toEqual(["2", "10"]);
    await menu.session.deleteSlot("2");
    expect(menu.session.slots().map((slot) => slot.id)).toEqual(["10"]);
  });

  it("saves where the story is from a menu reached by a navigation Signal", async () => {
    const { runtime, host } = createRuntime({ graph: createGraphWithArchiveAside() });
    await runtime.start();
    await nodeContext(host, "menu").navigation.emit("start");
    await nodeContext(host, "lobby").navigation.emit("home");
    await nodeContext(host, "menu").navigation.emit("inspect");
    await nodeContext(host, "archive").session.saveSlot("1");
    expect(nodeContext(host, "archive").session.slots()[0]).toMatchObject({ nodeId: "lobby" });
  });

  it("reports loading a slot under the report policy without leaving the Node", async () => {
    const { runtime, host } = createRuntime({ policy: "report" });
    await runtime.start();
    await nodeContext(host, "menu").session.saveSlot("1");
    await nodeContext(host, "menu").session.loadSlot("1");
    expect(runtime.snapshot()).toMatchObject({
      currentNodeId: "menu",
      reports: [expect.objectContaining({ kind: "continue", targetNodeId: "menu" })],
    });
  });
});

function seenRecord(nodes: string[]): PlayableSeen {
  return { version: 1, nodes: Object.fromEntries(nodes.map((id) => [id, "2026-09-27T00:00:00.000Z"])), edges: {} };
}

describe("NodeRuntime preview tooling", () => {
  it("reports Signals under the report policy without leaving the Node", async () => {
    const { runtime, host } = createRuntime({ policy: "report" });
    await runtime.start();

    await nodeContext(host, "menu").navigation.emit("start");
    await nodeContext(host, "menu").navigation.back();
    await nodeContext(host, "menu").navigation.emit("inspect");

    expect(host.events).toEqual(["mount:menu"]);
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      status: "running",
      policy: "report",
      currentNodeId: "menu",
      backStack: [],
    });
    expect(snapshot.recentSignals).toEqual([
      expect.objectContaining({ nodeId: "menu", signal: "start", targetNodeId: "lobby" }),
      expect.objectContaining({ nodeId: "menu", signal: "inspect", targetNodeId: "archive" }),
    ]);
    expect(snapshot.reports).toEqual([
      expect.objectContaining({ kind: "signal", signal: "start", targetNodeId: "lobby" }),
      { kind: "back", nodeId: "menu", at: "2026-09-28T00:00:00.000Z" },
      expect.objectContaining({ kind: "signal", nodeId: "menu", signal: "inspect", edgeId: "inspect-archive", targetNodeId: "archive", mode: "push" }),
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

    expect(host.events).toEqual(["mount:archive"]);
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

    expect(runtime.snapshot().stateAccess).toEqual({
      menu: { read: ["hasKey"], wrote: ["clues"] },
    });
    expect(() => menu.state.get("missing" as "hasKey")).toThrow();
    expect(runtime.snapshot().errors).toEqual([
      expect.objectContaining({ nodeId: "menu", code: "unknown-state-key" }),
    ]);
  });
});

function createRuntime(
  options: {
    graph?: NodeGraph;
    host?: FakeSurfaceHost;
    saveStore?: PlayableSaveStore;
    seenStore?: PlayableSeenStore;
    slotStore?: PlayableSlotStore;
    preferencesStore?: PlayablePreferencesStore;
    audio?: PlayableAudioHost;
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
  const graph = options.graph ?? createNodeGraphFixture();
  const host = options.host ?? new FakeSurfaceHost();
  return {
    host,
    runtime: new NodeRuntime({
      graph,
      compiled: createCompiledGraph(),
      graphSignature: "fixture-v1",
      surfaceHost: host,
      saveStore: options.saveStore ?? new MemoryPlayableSaveStore(),
      ...(options.seenStore ? { seenStore: options.seenStore } : {}),
      ...(options.slotStore ? { slotStore: options.slotStore } : {}),
      ...(options.preferencesStore ? { preferencesStore: options.preferencesStore } : {}),
      ...(options.audio ? { audio: options.audio } : {}),
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
  };
}

/** The fixture with the menu's archive entry as a navigation Signal instead of a step in the story. */
function createGraphWithArchiveAside(): NodeGraph {
  const graph = createNodeGraphFixture();
  const inspect = graph.nodes.find((node) => node.id === "menu")!.signals.find((signal) => signal.id === "inspect")!;
  inspect.role = "navigation";
  return graph;
}

function nodeContext(host: FakeSurfaceHost, id: string): NodeContext {
  const entry = [...host.nodeContexts]
    .reverse()
    .find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Node "${id}" was not mounted.`);
  return entry.context;
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
