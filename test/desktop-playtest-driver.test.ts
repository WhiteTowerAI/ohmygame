import { Window as DOMWindow, type HTMLInputElement as TestInput } from "happy-dom";
import { FOCUS_TARGET_SCRIPT } from "../src/desktop/page-input.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaytestSnapshot } from "../src/shared/playtest.js";

const electron = vi.hoisted(() => {
  class FakeImage {
    constructor(readonly width = 2, readonly height = 1) {}
    getSize() { return { width: this.width, height: this.height }; }
    resize = vi.fn((options: { width: number; height: number }) => new FakeImage(options.width, options.height));
    toJPEG = vi.fn((quality: number) => Buffer.from(`jpeg:${this.width}x${this.height}:${quality}`));
    toBitmap = vi.fn(() => Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]));
  }

  class FakeDebugger {
    attached = false;
    readonly commands: Array<{ method: string; parameters?: unknown }> = [];
    attach = vi.fn(() => { this.attached = true; });
    detach = vi.fn(() => { this.attached = false; });
    isAttached = vi.fn(() => this.attached);
    sendCommand = vi.fn(async (method: string, parameters?: unknown) => {
      this.commands.push({ method, parameters });
      return {};
    });
  }

  class FakeSession {
    permissionCheckHandler?: (contents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string; isMainFrame: boolean }) => boolean;
    permissionHandler?: (contents: unknown, permission: string, callback: (allowed: boolean) => void, details: { requestingUrl: string; isMainFrame: boolean }) => void;
    downloadHandler?: (event: { preventDefault(): void }) => void;
    requestErrorHandler?: (details: Record<string, unknown>) => void;
    requestStartHandler?: (details: Record<string, unknown>, callback: (response: object) => void) => void;
    requestDoneHandler?: (details: Record<string, unknown>) => void;
    proxy?: { proxyRules: string; proxyBypassRules: string };
    setProxy = vi.fn(async (config: { proxyRules: string; proxyBypassRules: string }) => { this.proxy = config; });
    setPermissionCheckHandler = vi.fn((handler) => { this.permissionCheckHandler = handler; });
    setPermissionRequestHandler = vi.fn((handler) => { this.permissionHandler = handler; });
    on = vi.fn((event: string, handler) => { if (event === "will-download") this.downloadHandler = handler; });
    readonly webRequest = {
      onErrorOccurred: vi.fn((handler) => { this.requestErrorHandler = handler; }),
      onBeforeRequest: vi.fn((handler) => { this.requestStartHandler = handler; }),
      onCompleted: vi.fn((handler) => { this.requestDoneHandler = handler; }),
    };
  }

  const windows: FakeWindow[] = [];
  class FakeWindow {
    readonly options: Record<string, any>;
    readonly debugger = new FakeDebugger();
    readonly session = new FakeSession();
    destroyed = false;
    loadedUrl = "";
    navigateHandler?: (event: { preventDefault(): void }, url: string) => void;
    redirectHandler?: (event: { preventDefault(): void }, url: string) => void;
    consoleHandler?: (details: { level: "error"; message: string; sourceId: string; lineNumber: number }) => void;
    navigationStartHandler?: (event: { isMainFrame: boolean; isSameDocument: boolean }) => void;
    closeHandler?: (event: { preventDefault(): void }) => void;
    closedHandler?: () => void;
    readonly setContentSize = vi.fn();
    readonly getContentSize = vi.fn(() => [this.options.width, this.options.height]);
    readonly showInactive = vi.fn();
    readonly hide = vi.fn();
    readonly loadURL = vi.fn(async (url: string) => { this.loadedUrl = url; });
    /** Page load listeners, for a reload. */
    readonly loadListeners = new Map<string, Set<(...args: any[]) => void>>();
    /** How the next reload ends. */
    reloadOutcome: "finish" | "fail" = "finish";
    /** Child frames of the page, such as a Playable Nodes sandbox. */
    readonly childFrames: { url: string; executeJavaScript: (script: string) => Promise<unknown> }[] = [];
    frameBoxes: { url: string; x: number; y: number; scaleX: number; scaleY: number }[] = [];
    /** What the game's playtest bridge `snapshot` returns; left out, the game has no bridge. */
    bridgeState?: () => unknown;
    /** Whether the game's bridge takes `bridge` actions. */
    bridgeActions = true;
    // Electron throws when a destroyed window's webContents is read.
    get webContents() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      return this.contents;
    }
    readonly contents = {
      id: windows.length + 1,
      debugger: this.debugger,
      session: this.session,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "will-navigate") this.navigateHandler = handler;
        if (event === "will-redirect") this.redirectHandler = handler;
        if (event === "console-message") this.consoleHandler = handler;
        if (event === "did-start-navigation") this.navigationStartHandler = handler;
        if (event === "did-finish-load" || event === "did-fail-load") {
          if (!this.loadListeners.has(event)) this.loadListeners.set(event, new Set());
          this.loadListeners.get(event)!.add(handler);
        }
      }),
      off: vi.fn((event: string, handler: any) => { this.loadListeners.get(event)?.delete(handler); }),
      reload: vi.fn(() => {
        setTimeout(() => {
          if (this.reloadOutcome === "finish") for (const listener of [...this.loadListeners.get("did-finish-load") ?? []]) listener();
          else for (const listener of [...this.loadListeners.get("did-fail-load") ?? []]) listener({}, -105, "ERR_NAME_NOT_RESOLVED", this.loadedUrl, true);
        }, 0);
      }),
      executeJavaScript: vi.fn(async (script: string): Promise<unknown> => {
        if (script.includes('deepQueryAll("iframe")')) return this.frameBoxes;
        if (script.includes("box.x + box.width / 2")) return this.childFrames.length ? null : { x: 20, y: 30 };
        if (script.includes("isContentEditable")) return true;
        if (script.includes("bridge[method]")) return this.bridgeActions;
        if (script.includes("available: false")) return this.bridgeState ? { available: true, state: this.bridgeState() } : { available: false };
        return {
          url: this.loadedUrl,
          title: "Test Game",
          readyState: "complete",
          viewport: { width: this.options.width, height: this.options.height },
          elements: [],
          canvases: [{ index: 0, width: 320, height: 180, box: { x: 0, y: 0, width: 320, height: 180 }, visible: true }],
        };
      }),
      capturePage: vi.fn(async () => new FakeImage()),
      setAudioMuted: vi.fn(),
      isDestroyed: vi.fn(() => this.destroyed),
      mainFrame: {
        frames: this.childFrames,
        executeJavaScript: (script: string) => this.contents.executeJavaScript(script),
      },
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      windows.push(this);
    }

    on(event: string, handler: any) { if (event === "close") this.closeHandler = handler; }
    once(event: string, handler: () => void) { if (event === "closed") this.closedHandler = handler; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.closedHandler?.(); }
  }
  return { windows, FakeWindow, FakeImage };
});

vi.mock("electron", () => ({ BrowserWindow: electron.FakeWindow }));

import { analyzeBitmap, ElectronPlaytestDriver, validatedPlaytestUrl } from "../src/desktop/playtest-driver.js";

beforeEach(() => { electron.windows.length = 0; });

describe("electron playtest driver", () => {
  it("opens only isolated local preview windows", async () => {
    const driver = new ElectronPlaytestDriver();
    const result = await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/game" },
      viewport: { width: 1280, height: 720 },
    });

    expect(result.operation).toBe("open");
    expect(electron.windows[0]?.options).toMatchObject({
      width: 1280,
      height: 720,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    expect(electron.windows[0]?.loadedUrl).toBe("http://127.0.0.1:43123/game?ohmygamePlaytest=1");
    expect(electron.windows[0]?.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(electron.windows[0]?.options.resizable).toBe(true);
    expect(electron.windows[0]?.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    driver.close();
  });

  it("keeps watched sessions independent and resizable", async () => {
    const driver = new ElectronPlaytestDriver();
    driver.setVisible(true);
    await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/" },
      viewport: { width: 800, height: 600 },
    });

    expect(electron.windows[0]?.options.parent).toBeUndefined();
    expect(electron.windows[0]?.options).toMatchObject({
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      minWidth: 240,
      minHeight: 240,
    });
    driver.close();
  });

  it("reveals loaded sessions without focusing and hides and mutes them without closing", async () => {
    const states: Array<{ visible: boolean; activeSessions: number }> = [];
    const driver = new ElectronPlaytestDriver((state) => states.push(state));
    driver.setVisible(true);
    const opened = await driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/" },
      viewport: { width: 800, height: 600 },
    });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(driver.watchState()).toEqual({ visible: true, activeSessions: 1 });

    const closeEvent = { preventDefault: vi.fn() };
    window.closeHandler?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(window.destroyed).toBe(false);
    expect(driver.watchState()).toEqual({ visible: false, activeSessions: 1 });

    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(window.destroyed).toBe(true);
    expect(driver.watchState()).toEqual({ visible: false, activeSessions: 0 });
    expect(states).toContainEqual({ visible: true, activeSessions: 1 });
    expect(states.at(-1)).toEqual({ visible: false, activeSessions: 0 });
  });

  it("records a session and reports the saved file", async () => {
    const recording = { path: ".ohmygame/media/imported/Agent playtest.mp4", name: "Agent playtest.mp4", duration: 4, bytes: 100 };
    const recorder = { start: vi.fn(async () => ({ outcome: Promise.resolve(recording) })), stop: vi.fn() };
    const driver = new ElectronPlaytestDriver(undefined, undefined, recorder);
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected a session");
    const sessionId = opened.snapshot.sessionId;
    await expect(driver.request({ operation: "recordStop", sessionId })).rejects.toThrow("not recording");
    await expect(driver.request({ operation: "recordStart", sessionId, projectId: "forest" })).resolves.toEqual({ operation: "recordStart", sessionId, maxSeconds: 60 });
    expect(recorder.start).toHaveBeenCalledWith(`agent:${sessionId}`, electron.windows[0]!.webContents, { title: "Agent playtest", maxSeconds: 60, projectId: "forest" });
    await expect(driver.request({ operation: "recordStart", sessionId, projectId: "forest" })).rejects.toThrow("already recorded");
    await expect(driver.request({ operation: "recordStop", sessionId })).resolves.toEqual({ operation: "recordStop", sessionId, recording });
    expect(recorder.stop).toHaveBeenCalledWith(`agent:${sessionId}`);
    driver.close();
  });

  it("finishes a recording when its session closes", async () => {
    const recorder = { start: vi.fn(async () => ({ outcome: new Promise<never>(() => {}) })), stop: vi.fn() };
    const driver = new ElectronPlaytestDriver(undefined, undefined, recorder);
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected a session");
    await driver.request({ operation: "recordStart", sessionId: opened.snapshot.sessionId, projectId: "forest" });
    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(recorder.stop).toHaveBeenCalledWith(`agent:${opened.snapshot.sessionId}`);
  });

  it("can't record without a recorder", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected a session");
    await expect(driver.request({ operation: "recordStart", sessionId: opened.snapshot.sessionId, projectId: "forest" })).rejects.toThrow("not available");
    driver.close();
  });

  it("closes sessions the agent leaves idle", async () => {
    vi.useFakeTimers();
    try {
      const driver = new ElectronPlaytestDriver(undefined, 1_000);
      const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      if (opened.operation !== "open") throw new Error("Expected open result");
      const window = electron.windows[0]!;

      vi.advanceTimersByTime(900);
      await driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId });
      vi.advanceTimersByTime(900);
      expect(window.destroyed).toBe(false);
      expect(driver.watchState().activeSessions).toBe(1);

      vi.advanceTimersByTime(100);
      expect(window.destroyed).toBe(true);
      expect(driver.watchState().activeSessions).toBe(0);
      await expect(driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId })).rejects.toThrow("Game session not found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the idle timer when a session is closed", async () => {
    vi.useFakeTimers();
    try {
      const driver = new ElectronPlaytestDriver(undefined, 1_000);
      const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      if (opened.operation !== "open") throw new Error("Expected open result");
      await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks navigation and redirects away from the preview origin", async () => {
    const driver = new ElectronPlaytestDriver();
    await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    const sameOrigin = { preventDefault: vi.fn() };
    const external = { preventDefault: vi.fn() };

    window.navigateHandler?.(sameOrigin, "http://127.0.0.1:43123/level-2");
    window.navigateHandler?.(external, "https://example.com/");
    const externalRedirect = { preventDefault: vi.fn() };
    window.redirectHandler?.(externalRedirect, "https://example.com/redirected");

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    expect(external.preventDefault).toHaveBeenCalledOnce();
    expect(externalRedirect.preventDefault).toHaveBeenCalledOnce();
    driver.close();
  });

  it("allows only same-origin main-frame game input permissions", async () => {
    const driver = new ElectronPlaytestDriver();
    await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    const check = window.session.permissionCheckHandler!;
    const request = window.session.permissionHandler!;
    const localMainFrame = { requestingUrl: "http://127.0.0.1:43123/game", isMainFrame: true };

    expect(check(window.webContents, "pointerLock", "http://127.0.0.1:43123", localMainFrame)).toBe(true);
    expect(check(window.webContents, "pointerLock", "https://example.com", { requestingUrl: "https://example.com", isMainFrame: true })).toBe(false);
    expect(check(window.webContents, "fullscreen", "http://127.0.0.1:43123", localMainFrame)).toBe(false);

    const pointerLock = vi.fn();
    const keyboardLock = vi.fn();
    const crossOrigin = vi.fn();
    request(window.webContents, "pointerLock", pointerLock, localMainFrame);
    request(window.webContents, "keyboardLock", keyboardLock, localMainFrame);
    request(window.webContents, "pointerLock", crossOrigin, { requestingUrl: "https://example.com", isMainFrame: true });
    expect(pointerLock).toHaveBeenCalledWith(true);
    expect(keyboardLock).toHaveBeenCalledWith(true);
    expect(crossOrigin).toHaveBeenCalledWith(false);
    driver.close();
  });

  it("doesn't report what a page dropped by leaving as failed requests", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    const session = window.session;
    const webContentsId = window.webContents.id;
    const start = (id: number, url: string) => session.requestStartHandler!({ id, url, webContentsId }, vi.fn());
    const fail = (id: number, url: string, error: string) => session.requestErrorHandler!({ id, url, error, webContentsId, timestamp: Date.now() });

    start(1, "http://127.0.0.1:43123/__ohmygame_preview_bridge__.js?document=1&events=1");
    start(2, "http://127.0.0.1:43123/battle.mp3");
    start(3, "http://127.0.0.1:43123/missing.png");
    window.navigationStartHandler!({ isMainFrame: true, isSameDocument: true });
    fail(3, "http://127.0.0.1:43123/missing.png", "net::ERR_FAILED");
    // Leaving for the sign-in page drops what the page was still loading.
    window.navigationStartHandler!({ isMainFrame: true, isSameDocument: false });
    fail(1, "http://127.0.0.1:43123/__ohmygame_preview_bridge__.js?document=1&events=1", "net::ERR_FAILED");
    fail(2, "http://127.0.0.1:43123/battle.mp3", "net::ERR_ABORTED");
    start(4, "http://127.0.0.1:43124/sign-in.css");
    fail(4, "http://127.0.0.1:43124/sign-in.css", "net::ERR_FAILED");

    const inspected = await driver.request({ operation: "inspect", sessionId: opened.snapshot.sessionId });
    if (inspected.operation !== "inspect") throw new Error("Expected inspect result");
    expect((inspected.snapshot as PlaytestSnapshot).failedRequests.map(({ url, error }) => ({ url, error }))).toEqual([
      { url: "http://127.0.0.1:43123/missing.png", error: "net::ERR_FAILED" },
      { url: "http://127.0.0.1:43124/sign-in.css", error: "net::ERR_FAILED" },
    ]);
    driver.close();
  });

  it("keeps session callbacks safe after the window is destroyed", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    const contents = window.webContents;
    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(window.destroyed).toBe(true);

    const mainFrame = { requestingUrl: "http://127.0.0.1:43123/", isMainFrame: true };
    expect(window.session.permissionCheckHandler!(contents, "pointerLock", "http://127.0.0.1:43123", mainFrame)).toBe(true);
    const callback = vi.fn();
    window.session.permissionHandler!(contents, "pointerLock", callback, mainFrame);
    expect(callback).toHaveBeenCalledWith(true);
    expect(() => window.session.requestErrorHandler!({ webContentsId: contents.id, url: "http://127.0.0.1:43123/a.png", error: "net::ERR_FAILED", timestamp: Date.now() })).not.toThrow();
  });

  it("closes a session whose window is destroyed before the closed event", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    // Keep the session registered until Electron delivers the closed event.
    window.destroyed = true;
    expect(driver.watchState().activeSessions).toBe(1);

    await expect(driver.request({ operation: "close", sessionId: opened.snapshot.sessionId })).resolves.toEqual({ operation: "close" });
    expect(driver.watchState().activeSessions).toBe(0);
    expect(window.debugger.isAttached).not.toHaveBeenCalled();
    expect(window.debugger.detach).not.toHaveBeenCalled();
    window.closedHandler?.();
    expect(driver.watchState().activeSessions).toBe(0);
  });

  it("bounds retained browser sessions", async () => {
    const driver = new ElectronPlaytestDriver();
    for (let index = 0; index < 4; index++) {
      await driver.request({ operation: "open", target: { runtime: "web", url: `http://127.0.0.1:43123/${index}` }, viewport: { width: 800, height: 600 } });
    }

    await expect(driver.request({
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43123/overflow" },
      viewport: { width: 800, height: 600 },
    })).rejects.toThrow("Close an existing game session");
    expect(electron.windows).toHaveLength(4);
    driver.close();
  });

  it("dispatches semantic actions through CDP and returns fresh state", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://localhost:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const result = await driver.request({
      operation: "act",
      sessionId: opened.snapshot.sessionId,
      actions: [
        { type: "click", target: { role: "button", name: "Start" } },
        { type: "type", target: { testId: "player-name" }, text: "Ada" },
        { type: "press", key: "Enter", duration: 1 },
        { type: "touch", x: 40, y: 60 },
        { type: "resize", viewport: { width: 390, height: 844 } },
        { type: "bridge", method: "setSeed", value: 7 },
      ],
    });

    expect(result.operation).toBe("act");
    expect(electron.windows[0]?.debugger.commands.map(({ method }) => method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
      "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchTouchEvent", "Input.dispatchTouchEvent",
    ]);
    expect(electron.windows[0]?.setContentSize).toHaveBeenCalledWith(390, 844);
    driver.close();
  });

  async function openPlayers(driver: ElectronPlaytestDriver, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
      if (opened.operation !== "open") throw new Error("Expected open result");
      ids.push(opened.snapshot.sessionId);
    }
    return ids;
  }

  it("runs players' actions at the same time and samples every session on the way", async () => {
    const driver = new ElectronPlaytestDriver();
    const [first, second] = await openPlayers(driver, 2);
    const order: string[] = [];
    electron.windows.forEach((window, index) => {
      window.debugger.sendCommand.mockImplementation(async (method: string, parameters?: unknown) => {
        order.push(`${index}:${(parameters as { type: string }).type}`);
        return {};
      });
      let x = index * 100;
      window.bridgeState = () => ({ x: x++ });
    });

    const result = await driver.request({
      operation: "actTogether",
      players: [
        { sessionId: first!, actions: [{ type: "press", key: "ArrowRight", duration: 60 }] },
        { sessionId: second!, actions: [{ type: "press", key: "ArrowLeft", duration: 60 }] },
      ],
      samples: [0, 30],
    });

    if (result.operation !== "actTogether") throw new Error("Expected actTogether result");
    // Both keys are down before either is released.
    expect(order.slice(0, 2).sort()).toEqual(["0:keyDown", "1:keyDown"]);
    expect(order.slice(2).sort()).toEqual(["0:keyUp", "1:keyUp"]);
    expect(result.snapshots.map((snapshot) => snapshot.sessionId)).toEqual([first, second]);
    // Each player held its key for 60 ms, and the call took no longer than the slowest of them.
    expect(result.timing.players.map((player) => player.sessionId)).toEqual([first, second]);
    for (const player of result.timing.players) expect(player.elapsedMs).toBeGreaterThanOrEqual(60);
    expect(result.timing.elapsedMs).toBeGreaterThanOrEqual(Math.max(...result.timing.players.map((player) => player.elapsedMs)));
    expect(result.samples).toHaveLength(2);
    expect(result.samples![0]!.states).toEqual({ [first!]: { x: 1 }, [second!]: { x: 101 } });
    expect(result.samples![1]!.atMs).toBeGreaterThanOrEqual(30);
    expect(Object.keys(result.samples![1]!.states)).toEqual([first, second]);
    driver.close();
  });

  it("stops the other players when one fails, and still releases their keys", async () => {
    const driver = new ElectronPlaytestDriver();
    const [first, second] = await openPlayers(driver, 2);
    electron.windows[1]!.bridgeActions = false;

    const failing = driver.request({
      operation: "actTogether",
      players: [
        { sessionId: first!, actions: [{ type: "press", key: "ArrowRight", duration: 5_000 }] },
        { sessionId: second!, actions: [{ type: "bridge", method: "reset" }] },
      ],
    });
    await expect(failing).rejects.toThrow(`Player 2 (${second}): The game playtest bridge does not support reset`);
    // The error says the first player was stopped, long before its 5 s hold would have ended.
    const message = await failing.then(() => "", (error: Error) => error.message);
    expect(message).toMatch(/player 1 stopped after (\d+) ms, player 2 failed after \d+ ms; \d+ ms in all/);
    expect(Number(/player 1 stopped after (\d+) ms/.exec(message)![1])).toBeLessThan(5_000);
    expect(electron.windows[0]!.debugger.commands.map(({ parameters }) => (parameters as { type: string }).type)).toEqual(["keyDown", "keyUp"]);
    driver.close();
  });

  it("refuses actTogether without separate open sessions or a bridge to sample", async () => {
    const driver = new ElectronPlaytestDriver();
    const [first, second] = await openPlayers(driver, 2);
    const wait = [{ type: "wait" as const, milliseconds: 1 }];

    await expect(driver.request({ operation: "actTogether", players: [{ sessionId: first!, actions: wait }] })).rejects.toThrow("2 to 4 players");
    await expect(driver.request({ operation: "actTogether", players: [{ sessionId: first!, actions: wait }, { sessionId: first!, actions: wait }] })).rejects.toThrow("its own game session");
    await expect(driver.request({ operation: "actTogether", players: [{ sessionId: first!, actions: wait }, { sessionId: "missing", actions: wait }] })).rejects.toThrow("Game session not found");
    await expect(driver.request({ operation: "actTogether", players: [{ sessionId: first!, actions: wait }, { sessionId: second!, actions: wait }], samples: [20, 10] })).rejects.toThrow("increasing");
    await expect(driver.request({ operation: "actTogether", players: [{ sessionId: first!, actions: wait }, { sessionId: second!, actions: wait }], samples: [10] })).rejects.toThrow("__OHMYGAME_PLAYTEST__.snapshot()");
    expect(electron.windows.flatMap((window) => window.debugger.commands)).toHaveLength(0);
    driver.close();
  });

  it("reads and clicks content inside scaled child frames", async () => {
    const driver = new ElectronPlaytestDriver();
    const opening = driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    window.frameBoxes = [{ url: "about:srcdoc", x: 100, y: 50, scaleX: 0.5, scaleY: 0.5 }];
    window.childFrames.push({
      url: "about:srcdoc",
      executeJavaScript: async (script: string) => script.includes("box.x + box.width / 2")
        ? { x: 30, y: 30 }
        : {
            elements: [{ index: 0, tag: "button", role: "button", name: "Take the train", text: "Take the train", enabled: true, box: { x: 10, y: 20, width: 40, height: 20 } }],
            text: "Platform 9 Take the train",
          },
    });
    const opened = await opening;
    if (opened.operation !== "open") throw new Error("Expected open result");
    const snapshot = opened.snapshot as PlaytestSnapshot;

    expect(snapshot.elements).toEqual([
      expect.objectContaining({ index: 0, name: "Take the train", box: { x: 105, y: 60, width: 20, height: 10 } }),
    ]);
    expect(snapshot.text).toBe("Platform 9 Take the train");

    await driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "click", target: { text: "Take the train" } }] });
    expect(window.debugger.commands[0]).toMatchObject({ method: "Input.dispatchMouseEvent", parameters: { type: "mouseMoved", x: 115, y: 65 } });
    driver.close();
  });

  it("returns screenshots with bounded pixel analysis", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const result = await driver.request({ operation: "capture", sessionId: opened.snapshot.sessionId });

    expect(result).toMatchObject({
      operation: "capture",
      capture: {
        mediaType: "image/jpeg",
        data: Buffer.from("jpeg:2x1:80").toString("base64"),
        width: 2,
        height: 1,
        analysis: { sampledPixels: 2, opaqueRatio: 1, likelyBlank: false },
      },
    });
    driver.close();
  });

  it("scales high-DPI screenshots to CSS pixels and keeps their aspect ratio", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 1200, height: 800 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0];
    const retina = new electron.FakeImage(2400, 1601);
    window.webContents.capturePage.mockResolvedValueOnce(retina);
    const result = await driver.request({ operation: "capture", sessionId: opened.snapshot.sessionId });

    expect(retina.resize).toHaveBeenCalledWith({ width: 1200, height: 801, quality: "best" });
    expect(retina.toBitmap).toHaveBeenCalled();
    expect(result).toMatchObject({
      operation: "capture",
      capture: { mediaType: "image/jpeg", data: Buffer.from("jpeg:1200x801:80").toString("base64"), width: 1200, height: 801 },
    });
    driver.close();
  });
});

describe("what plugins' game sessions add", () => {
  it("sends a session's traffic, loopback included, through its own proxy before the game loads, when asked", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 }, networkControl: true });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    expect(window.session.proxy).toEqual({ proxyRules: expect.stringMatching(/^socks5:\/\/127\.0\.0\.1:\d+$/), proxyBypassRules: "<-loopback>" });
    expect(window.session.setProxy.mock.invocationCallOrder[0]).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!);

    expect((await driver.request({ operation: "network", sessionId: opened.snapshot.sessionId, online: false })).operation).toBe("network");
    expect((await driver.request({ operation: "network", sessionId: opened.snapshot.sessionId, online: true })).operation).toBe("network");
    driver.close();
  });

  it("can't take a session off line that was opened without network control", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    expect(electron.windows[0]!.session.setProxy).not.toHaveBeenCalled();
    await expect(driver.request({ operation: "network", sessionId: opened.snapshot.sessionId, online: false })).rejects.toThrow("opened without network control");
    driver.close();
  });

  it("reloads the page and waits for it, or says why it failed", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;
    const reloaded = await driver.request({ operation: "reload", sessionId: opened.snapshot.sessionId });
    expect(reloaded.operation).toBe("reload");
    expect(window.contents.reload).toHaveBeenCalledTimes(1);
    expect(window.loadListeners.get("did-finish-load")?.size).toBe(0);

    window.reloadOutcome = "fail";
    await expect(driver.request({ operation: "reload", sessionId: opened.snapshot.sessionId })).rejects.toThrow("The game failed to reload: ERR_NAME_NOT_RESOLVED");
    driver.close();
  });
});

describe("playtest validation", () => {
  it("rejects non-local and credentialed URLs", () => {
    expect(() => validatedPlaytestUrl("https://127.0.0.1/game")).toThrow("local HTTP");
    expect(() => validatedPlaytestUrl("http://example.com/game")).toThrow("local HTTP");
    expect(() => validatedPlaytestUrl("http://user:pass@localhost/game")).toThrow("local HTTP");
  });

  it("detects flat frames while retaining useful metrics", () => {
    expect(analyzeBitmap(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1)).toEqual({
      sampledPixels: 2,
      opaqueRatio: 1,
      luminanceMean: 0,
      luminanceVariance: 0,
      likelyBlank: true,
    });
  });
});


it.each(["disabled", "readonly"])("refuses typing into a %s input instead of typing into the previous field", (attribute) => {
  const window = new DOMWindow();
  try {
    window.document.body.innerHTML = `<input id="previous"><input id="target" ${attribute}>`;
    const target = window.document.querySelector<TestInput>("#target")!;
    target.getBoundingClientRect = () => new window.DOMRect(0, 0, 100, 20);
    window.document.querySelector<TestInput>("#previous")!.focus();
    const result = window.eval(`(${FOCUS_TARGET_SCRIPT})({selector: "#target"})`);
    expect(result).toBe(false);
    expect(window.document.activeElement?.id).toBe("previous");
  } finally { window.happyDOM.abort(); }
});
