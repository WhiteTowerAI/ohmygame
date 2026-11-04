import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnedPlaytestDriver } from "../src/daemon/owned-playtest.js";
import { PluginGameRuntime, type PluginGameHooks } from "../src/daemon/plugin-game-runtime.js";
import type { GameUseHookInput } from "../src/shared/extension-host-protocol.js";
import type { PlaytestRequest, PluginGameUseSpec } from "../src/shared/playtest.js";

const PROVIDER = "ohmygame/maker:maker";
const TARGET = { runtime: "plugin", provider: PROVIDER, projectPath: "/game" } as const;

let folder: string;
let temporary: string;
let image: Buffer;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "omg-plugin-game-"));
  temporary = path.join(folder, "captures");
  await mkdir(temporary);
  // A frame with something on it, larger than a model reads.
  image = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#204080" } })
    .composite([{ input: await sharp({ create: { width: 600, height: 300, channels: 3, background: "#f0c020" } }).png().toBuffer(), left: 200, top: 200 }])
    .png()
    .toBuffer();
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A plugin's native code as the runtime sees it, recording what it was asked. */
function plugin(spec: PluginGameUseSpec = { operations: ["captureFrame"], maxFrame: 600 }) {
  const state = {
    calls: [] as GameUseHookInput[],
    generation: 1 as number | undefined,
    holds: 0,
    spec: spec as PluginGameUseSpec | undefined,
    write: async (output: string) => writeFile(output, image),
    /** What the plugin says it captured. */
    captured: (frame: number): unknown => ({ frame }),
    opened: 0,
    open: async (_signal?: AbortSignal): Promise<unknown> => ({ session: `plugin-session-${state.opened++}` }),
  };
  const hooks: PluginGameHooks = {
    call: async (input, signal) => {
      state.calls.push(input);
      if (input.operation === "open") return state.open(signal);
      if (input.operation === "captureFrame" || input.operation === "capture") {
        await state.write(input.output);
        return input.operation === "captureFrame" ? state.captured(input.frame) : {};
      }
      return {};
    },
    generation: async () => state.generation,
    hold: async () => {
      state.holds += 1;
      return () => { state.holds -= 1; };
    },
    current: async () => state.spec,
  };
  const runtime = new PluginGameRuntime({ provider: PROVIDER, version: "1.0.0", spec, hooks, temporaryDirectory: temporary });
  return { state, runtime };
}

async function open(runtime: PluginGameRuntime | OwnedPlaytestDriver) {
  const result = await runtime.request({ operation: "open", target: TARGET });
  if (result.operation !== "open") throw new Error("not opened");
  return result.snapshot.sessionId;
}

describe("plugin game runtime", () => {
  it("captures a frame of a fresh run, scaled to fit a model, and leaves no files behind", async () => {
    const { state, runtime } = plugin();
    const sessionId = await open(runtime);
    expect(sessionId).not.toBe("plugin-session-0");
    const result = await runtime.request({ operation: "captureFrame", sessionId, frame: 240 });
    if (result.operation !== "captureFrame") throw new Error("no capture");
    expect(result.capture).toMatchObject({
      sessionId,
      mediaType: "image/jpeg",
      width: 1568,
      height: 784,
      sourceWidth: 2000,
      sourceHeight: 1000,
      source: "fresh-run",
      frame: 240,
      analysis: { likelyBlank: false },
    });
    expect((await sharp(Buffer.from(result.capture.data, "base64")).metadata()).format).toBe("jpeg");
    // The plugin is asked for its own session and writes where the app chose.
    expect(state.calls[1]).toMatchObject({ operation: "captureFrame", session: "plugin-session-0", frame: 240 });
    expect(path.dirname((state.calls[1] as { output: string }).output)).toMatch(/ohmygame-capture-/);
    expect(await readdir(temporary)).toEqual([]);
  });

  it("reports a blank frame and passes on what the plugin said about it, cut short", async () => {
    const { state, runtime } = plugin();
    image = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#000" } }).png().toBuffer();
    state.captured = () => ({ frame: 420, notes: `  Still loading. ${"x".repeat(3_000)}` });
    const sessionId = await open(runtime);
    const result = await runtime.request({ operation: "captureFrame", sessionId, frame: 240 });
    if (result.operation !== "captureFrame") throw new Error("no capture");
    expect(result.capture.analysis.likelyBlank).toBe(true);
    expect(result.capture).not.toHaveProperty("sourceWidth");
    // The plugin may have moved on to a later frame while the game loaded.
    expect(result.capture.frame).toBe(420);
    expect(result.capture.notes).toMatch(/^Still loading\./);
    expect(result.capture.notes).toHaveLength(2_000);
  });

  it("refuses what the type doesn't declare and frames past its limit, without asking the plugin", async () => {
    const { state, runtime } = plugin();
    const sessionId = await open(runtime);
    for (const request of [
      { operation: "capture", sessionId },
      { operation: "inspect", sessionId },
      { operation: "act", sessionId, actions: [{ type: "wait", milliseconds: 10 }] },
      { operation: "recordStart", sessionId },
    ] satisfies PlaytestRequest[])
      await expect(runtime.request(request)).rejects.toThrow("does not support");
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 601 })).rejects.toThrow("from 1 to 600");
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1.5 })).rejects.toThrow("whole number");
    await expect(runtime.request({ operation: "open", target: { ...TARGET, provider: "someone/else:type" } })).rejects.toThrow(`opens ${PROVIDER}`);
    expect(state.calls).toHaveLength(1);
  });

  it("stops offering an operation the project's version no longer declares", async () => {
    const { state, runtime } = plugin();
    const sessionId = await open(runtime);
    state.spec = { operations: ["capture"] };
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 10 })).rejects.toThrow("no longer supports captureFrame");
    state.spec = undefined;
    await expect(runtime.request({ operation: "open", target: TARGET })).rejects.toThrow("no longer supports open");
    expect(state.calls).toHaveLength(1);
  });

  it("keeps the plugin's host running while a session is open", async () => {
    const { state, runtime } = plugin();
    const sessionId = await open(runtime);
    expect(state.holds).toBe(1);
    await runtime.request({ operation: "close", sessionId });
    expect(state.holds).toBe(0);
    expect(state.calls.at(-1)).toEqual({ operation: "close", session: "plugin-session-0" });
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow("not found");
  });

  it("ends the sessions of a host that restarted, without asking the new one about them", async () => {
    const { state, runtime } = plugin();
    const sessionId = await open(runtime);
    state.generation = 2;
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow("restarted");
    expect(state.holds).toBe(0);
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow("not found");
    // Closing another stale session doesn't reach the new host either.
    state.generation = 3;
    const stale = await open(runtime);
    state.generation = 4;
    const calls = state.calls.length;
    await runtime.request({ operation: "close", sessionId: stale });
    expect(state.calls).toHaveLength(calls);
    expect(state.holds).toBe(0);
  });

  it("closes a session the plugin opened after the call was cancelled", async () => {
    const { state, runtime } = plugin();
    let finish!: () => void;
    state.open = () => new Promise((resolve) => { finish = () => resolve({ session: "late" }); });
    const controller = new AbortController();
    const opening = runtime.request({ operation: "open", target: TARGET }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    // Given up on at once, though the plugin's open runs on.
    await expect(opening).rejects.toThrow();
    finish();
    await vi.waitFor(() => expect(state.calls.at(-1)).toEqual({ operation: "close", session: "late" }));
    expect(state.holds).toBe(0);
  });

  it("closes a session that finishes opening after the runtime closed", async () => {
    const { state, runtime } = plugin();
    let finish!: () => void;
    state.open = () => new Promise((resolve) => { finish = () => resolve({ session: "late" }); });
    const opening = runtime.request({ operation: "open", target: TARGET });
    await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.close();
    finish();
    await expect(opening).rejects.toThrow("closed");
    expect(state.calls.at(-1)).toEqual({ operation: "close", session: "late" });
    expect(state.holds).toBe(0);
  });

  it("refuses a capture that isn't an image, is a link, or is missing, and cleans up after each", async () => {
    const { state, runtime } = plugin();
    const sessionId = await open(runtime);
    state.write = (output) => writeFile(output, "not an image");
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow();
    state.write = async () => {};
    await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow();
    if (process.platform !== "win32") {
      const elsewhere = path.join(folder, "elsewhere.png");
      await writeFile(elsewhere, image);
      state.write = (output) => symlink(elsewhere, output);
      await expect(runtime.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow();
    }
    expect(await readdir(temporary)).toEqual([]);
  });

  it("says which plugin failed when its hook throws", async () => {
    const { state, runtime } = plugin();
    state.open = async () => { throw new Error("Prepare TapTap Maker first"); };
    await expect(runtime.request({ operation: "open", target: TARGET })).rejects.toThrow(`${PROVIDER} could not open the game: Prepare TapTap Maker first`);
    state.open = async () => ({});
    await expect(runtime.request({ operation: "open", target: TARGET })).rejects.toThrow("without naming its session");
    expect(state.holds).toBe(0);
  });

  it("limits the sessions open in a project", async () => {
    const { runtime } = plugin();
    for (let index = 0; index < 4; index++) await open(runtime);
    await expect(open(runtime)).rejects.toThrow("At most 4");
  });

  it("counts opens under way towards the limit", async () => {
    const { runtime } = plugin();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => open(runtime)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  });

  it("closes a session left unused", async () => {
    const { state } = plugin();
    const spec: PluginGameUseSpec = { operations: ["captureFrame"], maxFrame: 600 };
    const runtime = new PluginGameRuntime({
      provider: PROVIDER,
      version: "1.0.0",
      spec,
      idleMs: 20,
      temporaryDirectory: temporary,
      hooks: {
        call: async (input) => {
          state.calls.push(input);
          return input.operation === "open" ? { session: "idle" } : {};
        },
        generation: async () => 1,
        hold: async () => { state.holds += 1; return () => { state.holds -= 1; }; },
        current: async () => spec,
      },
    });
    await open(runtime);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.calls.at(-1)).toEqual({ operation: "close", session: "idle" });
    expect(state.holds).toBe(0);
  });

  it("keeps each conversation to the sessions it opened", async () => {
    const { runtime } = plugin();
    const mine = new OwnedPlaytestDriver(runtime);
    const theirs = new OwnedPlaytestDriver(runtime);
    const sessionId = await open(mine);
    await expect(theirs.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow("does not belong");
    await theirs.cleanup();
    expect((await mine.request({ operation: "captureFrame", sessionId, frame: 1 })).operation).toBe("captureFrame");
  });

  it("lets a conversation close a session that already ended", async () => {
    const { state, runtime } = plugin();
    const mine = new OwnedPlaytestDriver(runtime);
    const sessionId = await open(mine);
    state.generation = 2;
    await expect(mine.request({ operation: "captureFrame", sessionId, frame: 1 })).rejects.toThrow("restarted");
    expect(await mine.request({ operation: "close", sessionId })).toEqual({ operation: "close" });
    await expect(mine.request({ operation: "close", sessionId })).rejects.toThrow("does not belong");
  });
});
