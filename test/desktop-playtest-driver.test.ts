import { beforeEach, describe, expect, it, vi } from "vitest";

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
    permissionHandler?: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    downloadHandler?: (event: { preventDefault(): void }) => void;
    requestErrorHandler?: (details: Record<string, unknown>) => void;
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
    consoleHandler?: (details: { level: "error"; message: string; sourceId: string; lineNumber: number }) => void;
    closedHandler?: () => void;
    readonly setContentSize = vi.fn();
    readonly loadURL = vi.fn(async (url: string) => { this.loadedUrl = url; });
    readonly webContents = {
      id: windows.length + 1,
      debugger: this.debugger,
      session: this.session,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "will-navigate") this.navigateHandler = handler;
        if (event === "console-message") this.consoleHandler = handler;
      }),
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.includes("box.x + box.width / 2")) return { x: 20, y: 30 };
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
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      windows.push(this);
    }

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
      url: "http://127.0.0.1:43123/game",
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
    driver.close();
  });

  it("blocks navigation away from the preview origin", async () => {
    const driver = new ElectronPlaytestDriver();
    await driver.request({ operation: "open", url: "http://127.0.0.1:43123/", viewport: { width: 800, height: 600 } });
    const window = electron.windows[0]!;
    const sameOrigin = { preventDefault: vi.fn() };
    const external = { preventDefault: vi.fn() };

    window.navigateHandler?.(sameOrigin, "http://127.0.0.1:43123/level-2");
    window.navigateHandler?.(external, "https://example.com/");

    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    expect(external.preventDefault).toHaveBeenCalledOnce();
    driver.close();
  });

  it("dispatches semantic actions through CDP and returns fresh state", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", url: "http://localhost:43123/", viewport: { width: 800, height: 600 } });
    if (opened.operation !== "open") throw new Error("Expected open result");
    const result = await driver.request({
      operation: "act",
      sessionId: opened.snapshot.sessionId,
      actions: [
        { type: "click", target: { role: "button", name: "Start" } },
        { type: "type", target: { testId: "player-name" }, text: "Ada" },
        { type: "press", key: "Enter" },
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

  it("returns screenshots with bounded pixel analysis", async () => {
    const driver = new ElectronPlaytestDriver();
    const opened = await driver.request({ operation: "open", url: "http://127.0.0.1:43123/", viewport: { width: 800, height: 600 } });
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
