import { previewPagePath, previewPageUrl } from "../src/shared/preview-page.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webGamePlayerUrl } from "../src/shared/web-game-player.js";

const electron = vi.hoisted(() => {
  class Events {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    on(name: string, handler: (...args: any[]) => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
    emit(name: string, ...args: any[]) { for (const handler of this.handlers.get(name) ?? []) handler(...args); }
  }
  class Contents extends Events {
    destroyed = false;
    frame = { url: "", executeJavaScript: vi.fn(async () => {}) };
    mainFrame = { frames: [this.frame] };
    loadURL = vi.fn(async (_url: string) => {});
    executeJavaScript = vi.fn(async (script: string) => {
      if (script.startsWith("window.loadGame(")) this.frame.url = JSON.parse(script.slice(16, -1));
    });
    setWindowOpenHandler = vi.fn();
    setAudioMuted = vi.fn();
    focus = vi.fn();
    getZoomFactor = () => 1;
    isDestroyed = () => this.destroyed;
    close = vi.fn(() => { this.destroyed = true; });
    capturePage = vi.fn(async () => ({ toPNG: () => new Uint8Array([1, 2, 3]) }));
  }
  class Window extends Events {
    destroyed = false;
    minimized = false;
    visible = true;
    webContents = new Contents();
    children: View[] = [];
    contentView = {
      addChildView: (view: View) => { this.children.push(view); },
      removeChildView: (view: View) => { this.children = this.children.filter(item => item !== view); },
    };
    constructor(readonly options: Record<string, any> = {}) { super(); windows.push(this); }
    getContentSize = () => [this.options.width ?? 1000, this.options.height ?? 800];
    isDestroyed = () => this.destroyed;
    isMinimized = () => this.minimized;
    isVisible = () => this.visible;
    show = vi.fn(() => { this.visible = true; });
    focus = vi.fn();
    restore = vi.fn(() => { this.minimized = false; });
    close = vi.fn(() => { this.emit("close"); this.destroy(); });
    destroy = vi.fn(() => { this.destroyed = true; this.emit("closed"); });
  }
  class View {
    webContents = new Contents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(readonly options: Record<string, any>) { views.push(this); }
  }
  const windows: Window[] = [];
  const views: View[] = [];
  return { Window, View, windows, views, openExternal: vi.fn() };
});
vi.mock("electron", () => ({ BrowserWindow: electron.Window, WebContentsView: electron.View, shell: { openExternal: electron.openExternal } }));
import { WebGamePlayerWindows } from "../src/desktop/web-game-player.js";

beforeEach(() => { electron.windows.length = 0; electron.views.length = 0; });
const request = { path: "/play?mode=story#start", viewport: { width: 375, height: 667 } };
const target = { url: "http://127.0.0.1:43123", title: "My game" };
const url = previewPageUrl(`${target.url}${request.path}`, "editor", "editor-client");
const layout = { bounds: { x: 300, y: 100, width: 600, height: 500 }, visible: true };
const create = (states = vi.fn()) => new WebGamePlayerWindows(states, "file:///editor/web-game-host.html");
const loads = () => electron.views[0]!.webContents.executeJavaScript.mock.calls.filter(([script]) => script.startsWith("window.loadGame("));
const editor = () => new electron.Window() as unknown as Electron.BrowserWindow;

describe("shared desktop game", () => {
  it("moves the same view to Play and back without reloading, and reopens it at its current route", async () => {
    const states = vi.fn();
    const games = create(states);
    const owner = editor();
    const resolve = vi.fn(async () => target);
    await games.attach("game", "mount", owner, url, layout, resolve);
    const view = electron.views[0]!;
    expect(view.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    view.webContents.frame.url = `${target.url}/scene?level=2#boss`;
    await Promise.all([games.open("game", request, resolve), games.open("game", request, resolve)]);
    const player = electron.windows[1]!;
    expect(resolve).toHaveBeenCalledOnce();
    expect(electron.views).toHaveLength(1);
    expect(loads()).toHaveLength(1);
    expect(player.children).toEqual([view]);
    expect(electron.windows[0]!.children).toEqual([]);
    player.minimized = true;
    await games.open("game", { ...request, path: "/different" }, resolve);
    expect(player.restore).toHaveBeenCalledOnce();
    player.close();
    expect(games.state("game")).toMatchObject({ open: false, client: "editor-client" });
    expect(electron.windows[0]!.children).toEqual([view]);
    expect(view.webContents.destroyed).toBe(false);
    expect(previewPagePath(view.webContents.frame.url)).toBe("/scene?level=2#boss");
    await games.open("game", request, resolve);
    expect(electron.views).toHaveLength(1);
    expect(loads()).toHaveLength(1);
    games.close();
    expect(view.webContents.destroyed).toBe(true);
  });

  it("ignores stale editor cleanup and retains a player after leaving its project", async () => {
    const games = create();
    const owner = editor();
    await games.attach("game", "old", owner, url, layout, async () => target);
    await games.attach("game", "new", owner, url, layout, async () => target);
    games.detach("game", "old");
    expect(electron.views[0]!.webContents.destroyed).toBe(false);
    await games.open("game", request, async () => target);
    games.detach("game", "new");
    expect(electron.views[0]!.webContents.destroyed).toBe(false);
    games.closeProject("game");
    expect(electron.views[0]!.webContents.destroyed).toBe(true);
  });

  it("cancels a late startup when its editor is detached or the app shuts down", async () => {
    const games = create();
    let finish!: (value: typeof target) => void;
    const pending = games.attach("game", "mount", editor(), url, layout, () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    games.detach("game", "mount");
    finish(target);
    await expect(pending).rejects.toThrow("cancelled");
    expect(electron.views).toHaveLength(0);
    const launch = games.open("game", request, () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    games.close();
    finish(target);
    await expect(launch).rejects.toThrow("cancelled");
    expect(electron.views).toHaveLength(0);
  });

  it("refreshes the current scene, follows server changes, and recovers a crashed renderer", async () => {
    const games = create();
    await games.attach("game", "mount", editor(), url, layout, async () => target);
    const contents = electron.views[0]!.webContents;
    contents.frame.url = `${target.url}/scene?level=2#boss`;
    await games.refresh("game", async () => target);
    expect(loads()).toHaveLength(1);
    await games.refresh("game", async () => target, true);
    expect(previewPagePath(contents.frame.url)).toBe("/scene?level=2#boss");
    expect(loads()).toHaveLength(2);
    await games.refresh("game", async () => ({ ...target, url: "http://127.0.0.1:43124" }));
    expect(new URL(contents.frame.url).origin).toBe("http://127.0.0.1:43124");
    contents.emit("did-frame-navigate", {}, contents.frame.url, 200, "OK", false);
    contents.emit("render-process-gone");
    expect(games.state("game").error).toContain("Refresh");
    await games.refresh("game", async () => ({ ...target, url: "http://127.0.0.1:43124" }), true);
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    expect(games.state("game").error).toBeUndefined();
    expect(previewPagePath(contents.frame.url)).toBe("/scene?level=2#boss");
    games.close();
  });

  it("changes explicit routes without resetting a game merely because its editor remounted", async () => {
    const games = create();
    const owner = editor();
    await games.attach("game", "mount", owner, url, layout, async () => target);
    await games.attach("game", "mount", owner, `${target.url}/new?__ohmygame_client=editor-client`, layout, async () => target);
    expect(previewPagePath(electron.views[0]!.webContents.frame.url)).toBe("/new");
    await games.open("game", request, async () => target);
    games.detach("game", "mount");
    await games.attach("game", "remount", owner, url, layout, async () => target);
    expect(loads()).toHaveLength(2);
    expect(previewPagePath(electron.views[0]!.webContents.frame.url)).toBe("/new");
    games.close();
  });

  it("waits for a refreshed document before capturing its cover", async () => {
    const games = create();
    await games.attach("game", "mount", editor(), url, layout, async () => target);
    const contents = electron.views[0]!.webContents;
    let finish!: () => void;
    contents.executeJavaScript.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const loading = games.refresh("game", async () => target, true);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const capture = games.capture("game");
    await Promise.resolve();
    expect(contents.capturePage).not.toHaveBeenCalled();
    finish();
    await loading;
    await expect(capture).resolves.toEqual(new Uint8Array([1, 2, 3]));
    games.close();
  });

  it("clears a crashed process error when an explicit route recovers the game", async () => {
    const games = create();
    const owner = editor();
    await games.attach("game", "mount", owner, url, layout, async () => target);
    electron.views[0]!.webContents.emit("render-process-gone");
    expect(games.state("game").error).toContain("Refresh");
    await games.attach("game", "mount", owner, `${target.url}/new`, layout, async () => target);
    expect(games.state("game").error).toBeUndefined();
    expect(loads()).toHaveLength(2);
    games.close();
  });

  it("recovers the game route after a crash even if a nested frame navigated last", async () => {
    const games = create();
    await games.attach("game", "mount", editor(), url, layout, async () => target);
    const contents = electron.views[0]!.webContents;
    contents.frame.url = `${target.url}/scene?level=2#boss`;
    contents.emit("did-navigate-in-page", {}, contents.frame.url, false);
    contents.emit("did-frame-navigate", {}, `${target.url}/nested`, 200, "OK", false);
    contents.mainFrame.frames = [];
    contents.emit("render-process-gone");
    await games.refresh("game", async () => target, true);
    expect(previewPagePath(contents.frame.url)).toBe("/scene?level=2#boss");
    games.close();
  });

  it("clips editor bounds, mutes hidden previews, and ignores preview visibility while Play owns the view", async () => {
    const games = create();
    await games.attach("game", "mount", editor(), url, layout, async () => target);
    const view = electron.views[0]!;
    games.layout("game", "mount", { bounds: { x: 900, y: 700, width: 600, height: 500 }, visible: false });
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 900, y: 700, width: 100, height: 100 });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    await games.open("game", request, async () => target);
    games.layout("game", "mount", { ...layout, visible: false });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(await games.capture("game")).toEqual(new Uint8Array([1, 2, 3]));
    games.close();
  });

  it("rejects invalid servers and game navigation into the editor or another origin", async () => {
    const games = create();
    await expect(games.attach("bad", "mount", editor(), "https://example.com/", layout, async () => target)).rejects.toThrow();
    await games.attach("game", "mount", editor(), url, layout, async () => target);
    const contents = electron.views[0]!.webContents;
    const valid = { isMainFrame: false, url: `${target.url}/next`, preventDefault: vi.fn() };
    contents.emit("will-frame-navigate", valid);
    expect(valid.preventDefault).not.toHaveBeenCalled();
    for (const blocked of [{ ...valid, url: "https://example.com/", preventDefault: vi.fn() }, { ...valid, isMainFrame: true, preventDefault: vi.fn() }]) {
      contents.emit("will-frame-navigate", blocked);
      expect(blocked.preventDefault).toHaveBeenCalledOnce();
    }
    games.close();
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
