import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaytestSnapshot } from "../src/shared/playtest.js";

const electron = vi.hoisted(() => {
  class FakeImage {
    getSize() { return { width: 2, height: 1 }; }
    toPNG() { return Buffer.from("png"); }
    toBitmap() { return Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]); }
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
    readonly showInactive = vi.fn();
    readonly hide = vi.fn();
    readonly loadURL = vi.fn(async (url: string) => { this.loadedUrl = url; });
    /** Child frames of the page, such as a Playable Nodes sandbox. */
    readonly childFrames: { url: string; executeJavaScript: (script: string) => Promise<unknown> }[] = [];
    frameBoxes: { url: string; x: number; y: number; scaleX: number; scaleY: number }[] = [];
    readonly webContents = {
      id: windows.length + 1,
      debugger: this.debugger,
      session: this.session,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
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
      isDestroyed: vi.fn(() => this.destroyed),
      mainFrame: {
        frames: this.childFrames,
        executeJavaScript: (script: string) => this.webContents.executeJavaScript(script),
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
  return { windows, FakeWindow };
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

  it("reveals loaded sessions without focusing and hides them without closing", async () => {
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
    expect(driver.watchState()).toEqual({ visible: true, activeSessions: 1 });

    const closeEvent = { preventDefault: vi.fn() };
    window.closeHandler?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(false);
    expect(driver.watchState()).toEqual({ visible: false, activeSessions: 1 });

    await driver.request({ operation: "close", sessionId: opened.snapshot.sessionId });
    expect(window.destroyed).toBe(true);
    expect(driver.watchState()).toEqual({ visible: false, activeSessions: 0 });
    expect(states).toContainEqual({ visible: true, activeSessions: 1 });
    expect(states.at(-1)).toEqual({ visible: false, activeSessions: 0 });
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
        mediaType: "image/png",
        data: Buffer.from("png").toString("base64"),
        width: 2,
        height: 1,
        analysis: { sampledPixels: 2, opaqueRatio: 1, likelyBlank: false },
      },
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
