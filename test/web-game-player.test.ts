import { beforeEach, describe, expect, it, vi } from "vitest";
import { webGamePlayerUrl } from "../src/shared/web-game-player.js";

const electron = vi.hoisted(() => {
  class FakeWindow {
    readonly options: Record<string, unknown>;
    destroyed = false;
    minimized = false;
    url = "";
    closed?: () => void;
    navigate?: (event: { preventDefault(): void }, url: string) => void;
    readonly webContents = {
      getURL: () => this.url,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: typeof this.navigate) => { if (event === "will-navigate") this.navigate = handler; }),
    };
    readonly loadURL = vi.fn(async (url: string) => { this.url = url; });
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly restore = vi.fn(() => { this.minimized = false; });
    readonly destroy = vi.fn(() => { this.destroyed = true; this.closed?.(); });
    constructor(options: Record<string, unknown>) { this.options = options; windows.push(this); }
    once(event: string, listener: () => void) { if (event === "closed") this.closed = listener; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
  }
  const windows: FakeWindow[] = [];
  return { FakeWindow, windows, openExternal: vi.fn() };
});

vi.mock("electron", () => ({ BrowserWindow: electron.FakeWindow, shell: { openExternal: electron.openExternal } }));
import { WebGamePlayerWindows } from "../src/desktop/web-game-player.js";

beforeEach(() => { electron.windows.length = 0; });
const request = { path: "/play?mode=story#start", viewport: { width: 375, height: 667 } };
const target = { url: "http://127.0.0.1:43123", title: "My game" };

describe("human game windows", () => {
  it("shares a launch and refocuses an existing game without restarting or resizing it", async () => {
    const states = vi.fn();
    const players = new WebGamePlayerWindows(states);
    const resolve = vi.fn(async () => target);
    await Promise.all([players.open("game", request, resolve), players.open("game", request, resolve)]);
    const window = electron.windows[0]!;
    window.minimized = true;
    await players.open("game", { ...request, path: "/different", viewport: { width: 1280, height: 720 } }, resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(electron.windows).toHaveLength(1);
    expect(window.loadURL).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:43123/play?mode=story#start");
    expect(window.options).toMatchObject({ width: 375, height: 667, useContentSize: true });
    expect(window.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(window.restore).toHaveBeenCalledOnce();
    expect(players.state("game").open).toBe(true);
    window.destroy();
    expect(states.mock.calls.map(([state]) => state.open)).toEqual([true, false]);
    await players.open("game", request, resolve);
    expect(electron.windows).toHaveLength(2);
    players.close();
  });

  it("keeps project windows independent and closes them on editor shutdown", async () => {
    const players = new WebGamePlayerWindows(vi.fn());
    await players.open("first", request, async () => target);
    await players.open("second", request, async () => target);
    electron.windows[0]!.destroy();
    expect(players.state("first").open).toBe(false);
    expect(players.state("second").open).toBe(true);
    players.close();
    expect(electron.windows[1]!.destroyed).toBe(true);
  });

  it("allows another launch after failure without leaving a phantom game window", async () => {
    const players = new WebGamePlayerWindows(vi.fn());
    await expect(players.open("game", request, async () => { throw new Error("Server failed"); })).rejects.toThrow("Server failed");
    expect(players.state("game").open).toBe(false);
    await players.open("game", request, async () => target);
    expect(electron.windows).toHaveLength(1);
    players.close();
  });

  it("does not open a late window after the editor shuts down during server startup", async () => {
    const players = new WebGamePlayerWindows(vi.fn());
    let finish!: (value: typeof target) => void;
    const pending = players.open("game", request, () => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    players.close();
    finish(target);
    await expect(pending).rejects.toThrow("cancelled");
    expect(electron.windows).toHaveLength(0);
  });

  it("follows a restarted server at the current game route without resetting on unchanged URLs", async () => {
    const players = new WebGamePlayerWindows(vi.fn());
    await players.open("game", request, async () => target);
    const window = electron.windows[0]!;
    window.url = `${target.url}/level-2?save=1#boss`;
    await players.refresh("game", async () => target);
    expect(window.loadURL).toHaveBeenCalledOnce();
    await players.refresh("game", async () => ({ ...target, url: "http://127.0.0.1:43124" }));
    expect(window.url).toBe("http://127.0.0.1:43124/level-2?save=1#boss");
    const allowed = { preventDefault: vi.fn() };
    window.navigate?.(allowed, "http://127.0.0.1:43124/level-3");
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    const blocked = { preventDefault: vi.fn() };
    window.navigate?.(blocked, "https://example.com");
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    await players.refresh("game", async () => ({ ...target, url: "http://127.0.0.1:43124" }), true);
    expect(window.loadURL).toHaveBeenCalledTimes(3);
    players.close();
  });

  it("does not request a server after the player closes during refresh", async () => {
    const players = new WebGamePlayerWindows(vi.fn());
    await players.open("game", request, async () => target);
    const resolve = vi.fn(async () => target);
    const refresh = players.refresh("game", resolve);
    electron.windows[0]!.destroy();
    await refresh;
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("player URLs", () => {
  it("preserves game routing and removes the AI test flag", () => {
    expect(webGamePlayerUrl(target.url, "/play?ohmygamePlaytest=1&save=2#scene")).toBe(`${target.url}/play?save=2#scene`);
  });
  it.each(["https://example.com", "file:///tmp/game", "http://user:password@127.0.0.1:43123"])("rejects an invalid server %s", (url) => {
    expect(() => webGamePlayerUrl(url)).toThrow();
  });
  it.each(["https://example.com", "//example.com", "http://user:password@127.0.0.1:43123"])("rejects a route outside the game's origin %s", (route) => {
    expect(() => webGamePlayerUrl(target.url, route)).toThrow();
  });
});
