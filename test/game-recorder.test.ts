import { existsSync, readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GAME_RECORDING_MAX_BYTES, gameRecordingFileName } from "../src/shared/game-recording.js";
import type { GameRecordingFile } from "../src/desktop/game-recorder.js";

const electron = vi.hoisted(() => {
  const state = {
    hosts: [] as FakeHost[],
    channels: new Map<string, (event: { sender: { id: number } }, value: unknown) => void>(),
    displayHandler: undefined as undefined | ((request: { frame?: unknown }, callback: (streams: unknown) => void) => void),
    /** What the page does when told to start. */
    onStart: (() => ({ mediaType: "video/mp4", extension: "mp4" })) as () => unknown,
    /** Replaces the file being written. */
    sink: undefined as undefined | (() => unknown),
    /** How loading the page goes. */
    onLoad: (async () => {}) as () => Promise<void>,
    /** Whether the page answers when told to stop. */
    answersStop: true,
    nextId: 1,
  };
  class FakeContents {
    readonly id = state.nextId++;
    readonly handlers = new Map<string, () => void>();
    setWindowOpenHandler = vi.fn();
    on = vi.fn((name: string, handler: () => void) => { this.handlers.set(name, handler); });
    executeJavaScript = vi.fn(async (script: string) => {
      if (script.startsWith("window.startRecording")) return state.onStart();
      if (script === "window.stopRecording()" && state.answersStop) state.channels.get("ohmygame:game-recorder-finished")!({ sender: { id: this.id } }, 7.5);
      return undefined;
    });
  }
  class FakeHost {
    readonly webContents = new FakeContents();
    readonly options: Record<string, any>;
    destroyed = false;
    loadURL = vi.fn(() => state.onLoad());
    destroy = vi.fn(() => { this.destroyed = true; });
    isDestroyed = () => this.destroyed;
    constructor(options: Record<string, any>) {
      this.options = options;
      state.hosts.push(this);
    }
  }
  return { state, FakeHost };
});

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createWriteStream: (file: string) => electron.state.sink?.() ?? fs.createWriteStream(file) };
});
vi.mock("electron", () => ({
  BrowserWindow: electron.FakeHost,
  ipcMain: { on: (channel: string, listener: (event: { sender: { id: number } }, value: unknown) => void) => electron.state.channels.set(channel, listener) },
  session: { fromPartition: () => ({ setDisplayMediaRequestHandler: (handler: typeof electron.state.displayHandler) => { electron.state.displayHandler = handler; } }) },
  webContents: { fromFrame: (frame: { contents?: unknown }) => frame.contents },
}));

import { GameRecorder } from "../src/desktop/game-recorder.js";

const { state } = electron;
function target() {
  const listeners = new Map<string, () => void>();
  return {
    mainFrame: { name: "game frame" },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    once: vi.fn((name: string, listener: () => void) => { listeners.set(name, listener); }),
    removeListener: vi.fn(),
    fire: (name: string) => listeners.get(name)?.(),
  };
}
function recorder(save: (file: GameRecordingFile) => Promise<never> | Promise<{ assetId: string; name: string; duration: number; bytes: number }> = async (file) => {
  saved.push({ ...file, contents: readFileSync(file.path).toString() });
  return { assetId: "asset-1", name: "game.mp4", duration: file.duration, bytes: file.bytes };
}, onSaving?: (id: string) => void) {
  return new GameRecorder({ hostUrl: "file:///game-recorder.html", preloadPath: "/preload.cjs", save, ...(onSaving ? { onSaving } : {}) });
}
const saved: (GameRecordingFile & { contents: string })[] = [];
const options = { title: "Game", maxSeconds: 60 };
const send = (channel: string, id: number, value: unknown) => state.channels.get(`ohmygame:game-recorder-${channel}`)!({ sender: { id } }, value);

beforeEach(() => {
  state.hosts.length = 0;
  saved.length = 0;
  state.onStart = () => ({ mediaType: "video/mp4", extension: "mp4" });
  state.onLoad = async () => {};
  state.sink = undefined;
  state.answersStop = true;
});

describe("game recorder", () => {
  it("writes what the page sends to a file, saves it, and cleans up", async () => {
    const onSaving = vi.fn();
    const game = recorder(undefined, onSaving);
    const { outcome } = await game.start("project", target() as never, options);
    const host = state.hosts[0]!;
    expect(host.options).toMatchObject({ show: false, webPreferences: { preload: "/preload.cjs", sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    expect(game.isRecording("project")).toBe(true);
    send("chunk", host.webContents.id, new TextEncoder().encode("first,"));
    send("chunk", host.webContents.id, new TextEncoder().encode("second"));
    game.stop("project");
    game.stop("project");
    await expect(outcome).resolves.toEqual({ assetId: "asset-1", name: "game.mp4", duration: 7.5, bytes: 12 });
    expect(saved[0]).toMatchObject({ title: "Game", duration: 7.5, bytes: 12, mediaType: "video/mp4", extension: "mp4", contents: "first,second" });
    expect(onSaving).toHaveBeenCalledOnce();
    expect(host.destroyed).toBe(true);
    expect(game.isRecording("project")).toBe(false);
    expect(existsSync(saved[0]!.path)).toBe(false);
  });

  it("captures only the game it was asked to, for only its own page", async () => {
    const game = recorder();
    const played = target();
    const { outcome } = await game.start("project", played as never, options);
    const callback = vi.fn();
    state.displayHandler!({ frame: { contents: state.hosts[0]!.webContents } }, callback);
    expect(callback).toHaveBeenCalledWith({ video: played.mainFrame, audio: played.mainFrame, enableLocalEcho: true });
    for (const frame of [{ contents: { id: 9999 } }, undefined]) {
      const refused = vi.fn();
      state.displayHandler!({ frame }, refused);
      expect(refused).toHaveBeenCalledWith({});
    }
    game.stop("project");
    await outcome;
  });

  it("ignores pieces from any other page", async () => {
    const game = recorder();
    const { outcome } = await game.start("project", target() as never, options);
    send("chunk", 9999, new TextEncoder().encode("not ours"));
    send("finished", 9999, 1);
    send("failed", 9999, "not ours");
    expect(game.isRecording("project")).toBe(true);
    game.stop("project");
    await expect(outcome).resolves.toMatchObject({ bytes: 0, duration: 7.5 });
  });

  it("stops by itself at its time limit", async () => {
    const game = recorder();
    const { outcome } = await game.start("project", target() as never, { title: "Game", maxSeconds: 0.01 });
    await expect(outcome).resolves.toMatchObject({ assetId: "asset-1" });
    expect(game.isRecording("project")).toBe(false);
  });

  it("stops before the file outgrows the Library", async () => {
    const game = recorder(async (file) => ({ assetId: "asset-1", name: "game.mp4", duration: file.duration, bytes: file.bytes }));
    const { outcome } = await game.start("project", target() as never, options);
    send("chunk", state.hosts[0]!.webContents.id, new Uint8Array(GAME_RECORDING_MAX_BYTES));
    await expect(outcome).resolves.toMatchObject({ bytes: GAME_RECORDING_MAX_BYTES });
  });

  it("keeps what was recorded when the game closes", async () => {
    const game = recorder();
    const played = target();
    const { outcome } = await game.start("project", played as never, options);
    played.fire("destroyed");
    await expect(outcome).resolves.toMatchObject({ assetId: "asset-1" });
  });

  it("accepts a recording the page finished by itself", async () => {
    const onSaving = vi.fn();
    const game = recorder(undefined, onSaving);
    const { outcome } = await game.start("project", target() as never, options);
    send("finished", state.hosts[0]!.webContents.id, 3);
    await expect(outcome).resolves.toMatchObject({ assetId: "asset-1" });
    expect(onSaving).toHaveBeenCalledOnce();
  });

  it("reports a failed recording and leaves nothing behind", async () => {
    const save = vi.fn();
    const game = recorder(save);
    const { outcome } = await game.start("project", target() as never, options);
    send("failed", state.hosts[0]!.webContents.id, "The encoder stopped.");
    await expect(outcome).rejects.toThrow("The encoder stopped.");
    expect(save).not.toHaveBeenCalled();
    expect(state.hosts[0]!.destroyed).toBe(true);
    expect(game.isRecording("project")).toBe(false);
  });

  it("doesn't save a file whose last write failed", async () => {
    state.sink = () => new Writable({ write: (_chunk, _encoding, done) => done(), final: (done) => done(new Error("The disk is full.")) });
    const save = vi.fn();
    const game = recorder(save);
    const { outcome } = await game.start("project", target() as never, options);
    game.stop("project");
    await expect(outcome).rejects.toThrow("The disk is full.");
    expect(save).not.toHaveBeenCalled();
    expect(game.isRecording("project")).toBe(false);
  });

  it("gives up on a page that never finishes", async () => {
    state.answersStop = false;
    const game = recorder();
    const { outcome } = await game.start("project", target() as never, options);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      game.stop("project");
      vi.advanceTimersByTime(20_000);
    } finally { vi.useRealTimers(); }
    await expect(outcome).rejects.toThrow("could not be finished");
    expect(game.isRecording("project")).toBe(false);
  });

  it("can record again after failing to start, but not twice at once", async () => {
    const game = recorder();
    state.onStart = () => { throw new Error("No permission"); };
    await expect(game.start("project", target() as never, options)).rejects.toThrow("No permission");
    expect(state.hosts[0]!.destroyed).toBe(true);
    expect(game.isRecording("project")).toBe(false);
    state.onStart = () => ({ mediaType: "video/webm", extension: "webm" });
    const { outcome } = await game.start("project", target() as never, options);
    await expect(game.start("project", target() as never, options)).rejects.toThrow("already recording");
    game.stop("project");
    await outcome;
    expect(saved[0]).toMatchObject({ mediaType: "video/webm", extension: "webm" });
  });

  it("lets only one of two starts at once through", async () => {
    const game = recorder();
    const first = game.start("project", target() as never, options);
    await expect(game.start("project", target() as never, options)).rejects.toThrow("already recording");
    expect(state.hosts).toHaveLength(1);
    const { outcome } = await first;
    game.stop("project");
    await outcome;
  });

  it("finishes a recording stopped while it was still starting", async () => {
    let started!: (value: unknown) => void;
    state.onStart = () => new Promise((resolve) => { started = resolve; });
    const game = recorder();
    const starting = game.start("project", target() as never, options);
    await vi.waitFor(() => expect(started).toBeDefined());
    game.stop("project");
    const contents = state.hosts[0]!.webContents;
    expect(contents.executeJavaScript).not.toHaveBeenCalledWith("window.stopRecording()");
    started({ mediaType: "video/mp4", extension: "mp4" });
    const { outcome } = await starting;
    expect(contents.executeJavaScript).toHaveBeenCalledWith("window.stopRecording()");
    await expect(outcome).resolves.toMatchObject({ assetId: "asset-1" });
  });

  it("gives up on a page that never starts", async () => {
    state.onStart = () => new Promise(() => {});
    const game = recorder();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const starting = game.start("project", target() as never, options);
      const failed = expect(starting).rejects.toThrow("could not be started");
      await vi.advanceTimersByTimeAsync(20_000);
      await failed;
    } finally { vi.useRealTimers(); }
    expect(state.hosts[0]!.destroyed).toBe(true);
    expect(game.isRecording("project")).toBe(false);
  });

  it("gives up on a page that never loads", async () => {
    state.onLoad = () => new Promise(() => {});
    const game = recorder();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const failed = expect(game.start("project", target() as never, options)).rejects.toThrow("could not be started");
      await vi.advanceTimersByTimeAsync(20_000);
      await failed;
    } finally { vi.useRealTimers(); }
    expect(game.isRecording("project")).toBe(false);
  });

  it("abandons a recording still starting when the app closes", async () => {
    state.onLoad = () => new Promise(() => {});
    const game = recorder();
    const starting = game.start("project", target() as never, options);
    game.close();
    await expect(starting).rejects.toThrow("closed while recording");
    expect(state.hosts[0]!.destroyed).toBe(true);
    expect(game.isRecording("project")).toBe(false);
  });

  it("holds the recording until it is saved", async () => {
    let finishSave!: (value: { assetId: string; name: string; duration: number; bytes: number }) => void;
    const save = vi.fn((_file: GameRecordingFile) => new Promise<{ assetId: string; name: string; duration: number; bytes: number }>((resolve) => { finishSave = resolve; }));
    const game = recorder(save);
    const { outcome } = await game.start("project", target() as never, options);
    const host = state.hosts[0]!;
    send("chunk", host.webContents.id, new TextEncoder().encode("play"));
    game.stop("project");
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    // Its window keeps the app alive, and a new recording can't overlap the old one's result.
    expect(host.destroyed).toBe(false);
    expect(game.isRecording("project")).toBe(true);
    await expect(game.start("project", target() as never, options)).rejects.toThrow("already recording");
    send("chunk", host.webContents.id, new TextEncoder().encode("late"));
    finishSave({ assetId: "asset-1", name: "game.mp4", duration: 1, bytes: 4 });
    await outcome;
    expect(save.mock.calls[0]![0]).toMatchObject({ bytes: 4 });
    expect(host.destroyed).toBe(true);
    expect(game.isRecording("project")).toBe(false);
  });

  it("refuses a game that has already closed", async () => {
    const closed = target();
    closed.destroyed = true;
    await expect(recorder().start("project", closed as never, options)).rejects.toThrow("no longer running");
    expect(state.hosts).toHaveLength(0);
  });

  it("keeps the file and says where when the Library can't take it", async () => {
    const game = recorder(async () => { throw new Error("The Library is full."); });
    const { outcome } = await game.start("project", target() as never, options);
    send("chunk", state.hosts[0]!.webContents.id, new TextEncoder().encode("play"));
    game.stop("project");
    const error = await outcome.catch((cause: Error) => cause) as Error;
    const kept = /still at (.+)\.$/.exec(error.message)?.[1];
    expect(error.message).toContain("The Library is full.");
    expect(readFileSync(kept!).toString()).toBe("play");
    await rm(dirname(kept!), { recursive: true });
  });

  it("abandons recordings when the app closes", async () => {
    const game = recorder();
    const { outcome } = await game.start("project", target() as never, options);
    game.close();
    await expect(outcome).rejects.toThrow("closed while recording");
    expect(state.hosts[0]!.destroyed).toBe(true);
  });
});

describe("recording file names", () => {
  const at = new Date(2026, 10, 2, 9, 5, 7);

  it("names a recording after its game and time", () => {
    expect(gameRecordingFileName("Zombie Farm", at, "mp4")).toBe("Zombie Farm 2026-11-02 09-05-07.mp4");
  });

  it("removes what a file name can't hold", () => {
    expect(gameRecordingFileName("../a:b*c?\n", at, "webm")).toBe("-a-b-c-- 2026-11-02 09-05-07.webm");
    expect(gameRecordingFileName("  ...  ", at, "mp4")).toBe("Game 2026-11-02 09-05-07.mp4");
    expect(gameRecordingFileName("x".repeat(500), at, "mp4")).toHaveLength(120 + " 2026-11-02 09-05-07.mp4".length);
  });
});
