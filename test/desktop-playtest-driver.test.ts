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
    setProxy = vi.fn(async (_config: { proxyRules: string; proxyBypassRules: string }) => {});
    setPermissionCheckHandler = vi.fn((handler) => { this.permissionCheckHandler = handler; });
    setPermissionRequestHandler = vi.fn((handler) => { this.permissionHandler = handler; });
    on = vi.fn((event: string, handler) => { if (event === "will-download") this.downloadHandler = handler; });
    readonly webRequest = { onErrorOccurred: vi.fn((handler) => { this.requestErrorHandler = handler; }) };
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
    closeHandler?: (event: { preventDefault(): void }) => void;
    closedHandler?: () => void;
    readonly setContentSize = vi.fn();
    readonly getContentSize = vi.fn(() => [this.options.width, this.options.height]);
    readonly showInactive = vi.fn();
    readonly hide = vi.fn();
    readonly loadURL = vi.fn(async (url: string) => { this.loadedUrl = url; });
    /** Child frames of the page, such as a Playable Nodes sandbox. */
    readonly childFrames: { url: string; executeJavaScript: (script: string) => Promise<unknown> }[] = [];
    frameBoxes: { url: string; x: number; y: number; scaleX: number; scaleY: number }[] = [];
    readonly loadHandlers = new Map<string, Set<(...args: any[]) => void>>();
    /** What a reload does: by default the page loads again. */
    reloadOutcome: "load" | "fail" | "hang" = "load";
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
      reload: vi.fn(() => {
        if (this.reloadOutcome === "hang") return;
        queueMicrotask(() => {
          for (const handler of [...this.loadHandlers.get(this.reloadOutcome === "load" ? "did-finish-load" : "did-fail-load") ?? []])
            handler({}, -105, "ERR_NAME_NOT_RESOLVED", this.loadedUrl, true);
        });
      }),
      off: vi.fn((event: string, handler: any) => { this.loadHandlers.get(event)?.delete(handler); }),
      on: vi.fn((event: string, handler: any) => {
        if (event === "did-finish-load" || event === "did-fail-load") {
          if (!this.loadHandlers.has(event)) this.loadHandlers.set(event, new Set());
          this.loadHandlers.get(event)!.add(handler);
        }
        if (event === "will-navigate") this.navigateHandler = handler;
        if (event === "will-redirect") this.redirectHandler = handler;
        if (event === "console-message") this.consoleHandler = handler;
      }),
      executeJavaScript: vi.fn(async (script: string): Promise<unknown> => {
        if (script.includes('deepQueryAll("iframe")')) return this.frameBoxes;
        if (script.includes("box.x + box.width / 2")) return this.childFrames.length ? null : { x: 20, y: 30 };
        if (script.includes("isContentEditable")) return true;
        if (script.includes("bridge[method]")) return true;
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
  /** Each session's network, in the order they open. */
  const networks: FakeNetwork[] = [];
  class FakeNetwork {
    readonly events: string[] = [];
    constructor() { networks.push(this); }
    listen = vi.fn(async () => `socks5://127.0.0.1:${40000 + networks.indexOf(this)}`);
    cut = vi.fn(() => { this.events.push("cut"); });
    restore = vi.fn(() => { this.events.push("restore"); });
    close = vi.fn(() => { this.events.push("close"); });
  }
  return { windows, FakeWindow, FakeImage, networks, FakeNetwork };
});

vi.mock("electron", () => ({ BrowserWindow: electron.FakeWindow }));
vi.mock("../src/desktop/playtest-network.js", () => ({ PlaytestNetwork: electron.FakeNetwork }));

import { analyzeBitmap, ElectronPlaytestDriver, validatedPlaytestUrl } from "../src/desktop/playtest-driver.js";

beforeEach(() => { electron.windows.length = 0; electron.networks.length = 0; });

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
    const recording = { assetId: "asset-1", name: "Agent playtest.mp4", duration: 4, bytes: 100 };
    const recorder = { start: vi.fn(async () => ({ outcome: Promise.resolve(recording) })), stop: vi.fn() };
    const driver = new ElectronPlaytestDriver(undefined, undefined, recorder);
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected a session");
    const sessionId = opened.snapshot.sessionId;
    await expect(driver.request({ operation: "recordStop", sessionId })).rejects.toThrow("not recording");
    await expect(driver.request({ operation: "recordStart", sessionId })).resolves.toEqual({ operation: "recordStart", sessionId, maxSeconds: 60 });
    expect(recorder.start).toHaveBeenCalledWith(`agent:${sessionId}`, electron.windows[0]!.webContents, { title: "Agent playtest", maxSeconds: 60 });
    await expect(driver.request({ operation: "recordStart", sessionId })).rejects.toThrow("already recorded");
    await expect(driver.request({ operation: "recordStop", sessionId })).resolves.toEqual({ operation: "recordStop", sessionId, recording });
    expect(recorder.stop).toHaveBeenCalledWith(`agent:${sessionId}`);
    driver.close();
  });

  it("finishes a recording when its session closes", async () => {
    const recorder = { start: vi.fn(async () => ({ outcome: new Promise<never>(() => {}) })), stop: vi.fn() };
    const driver = new ElectronPlaytestDriver(undefined, undefined, recorder);
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected a session");
    await driver.request({ operation: "recordStart", sessionId: opened.snapshot.sessionId });
    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(recorder.stop).toHaveBeenCalledWith(`agent:${opened.snapshot.sessionId}`);
  });

  it("can't record without a recorder", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected a session");
    await expect(driver.request({ operation: "recordStart", sessionId: opened.snapshot.sessionId })).rejects.toThrow("not available");
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

  it("sends each session's traffic, loopback included, through a network it can cut", async () => {
    const driver = new ElectronPlaytestDriver();
    await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });

    expect(electron.windows.map((window) => window.session.setProxy.mock.calls[0]?.[0])).toEqual([
      { proxyRules: "socks5://127.0.0.1:40000", proxyBypassRules: "<-loopback>" },
      { proxyRules: "socks5://127.0.0.1:40001", proxyBypassRules: "<-loopback>" },
    ]);
    // Set before the page loads, so its first connections go through it too.
    expect(electron.windows[0]!.session.setProxy.mock.invocationCallOrder[0]).toBeLessThan(electron.windows[0]!.loadURL.mock.invocationCallOrder[0]!);
    driver.close();
    for (const network of electron.networks) expect(network.close).toHaveBeenCalled();
  });

  it("keeps a page offline for the time asked, then brings its network back", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const network = electron.networks[0]!;
    network.cut.mockImplementation(() => { network.events.push(`cut@${Date.now()}`); });
    network.restore.mockImplementation(() => { network.events.push(`restore@${Date.now()}`); });

    await driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "offline", milliseconds: 80 }] });

    const [cut, restore] = network.events.map((event) => Number(event.split("@")[1]));
    expect(network.events.map((event) => event.split("@")[0])).toEqual(["cut", "restore"]);
    expect(restore! - cut!).toBeGreaterThanOrEqual(75);
    await expect(driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "offline", milliseconds: 20_001 }] })).rejects.toThrow("between 1 and 20000ms");

    // A cancelled call still brings the network back.
    const controller = new AbortController();
    const offline = driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "offline", milliseconds: 10_000 }] }, controller.signal);
    await vi.waitFor(() => expect(network.events.at(-1)).toMatch(/^cut/));
    controller.abort();
    await expect(offline).rejects.toMatchObject({ name: "AbortError" });
    expect(network.events.at(-1)).toMatch(/^restore/);
    driver.close();
  });

  it("reloads the page and waits until it has loaded again", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", target: { runtime: "web", url: "http://127.0.0.1:43123/" }, viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const window = electron.windows[0]!;

    const result = await driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "reload" }] });
    expect(result.operation).toBe("act");
    expect(window.contents.reload).toHaveBeenCalledOnce();
    expect(window.loadHandlers.get("did-finish-load")?.size).toBe(0);

    window.reloadOutcome = "fail";
    await expect(driver.request({ operation: "act", sessionId: opened.snapshot.sessionId, actions: [{ type: "reload" }] })).rejects.toThrow("The page did not reload: ERR_NAME_NOT_RESOLVED");
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
