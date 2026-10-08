import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ windows: [] as unknown[], openExternal: vi.fn(async () => {}) }));

vi.mock("electron", () => ({
  shell: { openExternal: electron.openExternal },
  nativeTheme: { shouldUseDarkColors: false },
  BrowserWindow: class {
    readonly options: Record<string, unknown>;
    readonly webContents = {
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
        this.onWindowOpen = handler;
      }),
      on: vi.fn((event: string, handler: (event: { preventDefault(): void }, url: string) => void) => {
        if (event === "will-navigate") this.onNavigate = handler;
      }),
      setAudioMuted: vi.fn(),
    };
    readonly once = vi.fn();
    readonly loadURL = vi.fn(async () => {});
    readonly setAspectRatio = vi.fn();
    onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    onWindowOpen?: (details: { url: string }) => { action: string };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      electron.windows.push(this);
    }
    show() {}
  },
}));

import { createDesktopWindow, fitPlaytestContentSize, isValidPlaytestViewport } from "../src/desktop/window.js";

beforeEach(() => {
  electron.windows.length = 0;
  electron.openExternal.mockClear();
});

describe("desktop window", () => {
  it("blocks main-frame navigation away from the renderer", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as {
      loadURL: ReturnType<typeof vi.fn>;
      onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    };

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:43120/");
    const allowed = { preventDefault: vi.fn() };
    window.onNavigate?.(allowed, "http://127.0.0.1:43120/");
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    const rejected = { preventDefault: vi.fn() };
    window.onNavigate?.(rejected, "https://untrusted.example/");
    expect(rejected.preventDefault).toHaveBeenCalledOnce();
  });

  it("mutes a hidden window, such as a thumbnail capture", async () => {
    const options = {
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    };
    await createDesktopWindow({ ...options, hidden: true });
    await createDesktopWindow(options);
    const [hidden, shown] = electron.windows as { webContents: { setAudioMuted: ReturnType<typeof vi.fn> } }[];

    expect(hidden!.webContents.setAudioMuted).toHaveBeenCalledWith(true);
    expect(shown!.webContents.setAudioMuted).not.toHaveBeenCalled();
  });

  it("opens only HTTP links in the system browser", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    const window = electron.windows[0] as {
      onWindowOpen?: (details: { url: string }) => { action: string };
    };

    expect(window.onWindowOpen?.({ url: "https://example.com/game" })).toEqual({ action: "deny" });
    expect(window.onWindowOpen?.({ url: "http://127.0.0.1:43130/games/game-1" })).toEqual({ action: "deny" });
    expect(window.onWindowOpen?.({ url: "file:///tmp/private" })).toEqual({ action: "deny" });
    expect(window.onWindowOpen?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(electron.openExternal).toHaveBeenCalledTimes(2);
    expect(electron.openExternal).toHaveBeenNthCalledWith(1, "https://example.com/game");
    expect(electron.openExternal).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43130/games/game-1");
  });

  it("loads and permits a renderer hash route", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      rendererHash: "#/playtest/project",
    });
    const window = electron.windows[0] as {
      loadURL: ReturnType<typeof vi.fn>;
      onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    };

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:43120/#/playtest/project");
    const navigation = { preventDefault: vi.fn() };
    window.onNavigate?.(navigation, "http://127.0.0.1:43120/#/playtest/project");
    expect(navigation.preventDefault).not.toHaveBeenCalled();
  });

  it("supports a fixed content aspect ratio for playtest windows", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      contentSize: { width: 1280, height: 720 },
      aspectRatio: 16 / 9,
      minWidth: 640,
      minHeight: 360,
    });
    const window = electron.windows[0] as {
      options: Record<string, unknown>;
      setAspectRatio: ReturnType<typeof vi.fn>;
    };

    expect(window.options).toMatchObject({
      width: 1280,
      height: 720,
      minWidth: 640,
      minHeight: 360,
      useContentSize: true,
    });
    expect(window.setAspectRatio).toHaveBeenCalledWith(16 / 9);
  });

  it.each([
    ["landscape", { width: 1280, height: 720 }, { width: 1280, height: 720 }],
    ["portrait", { width: 720, height: 1280 }, { width: 450, height: 800 }],
    ["square", { width: 1080, height: 1080 }, { width: 800, height: 800 }],
    ["custom", { width: 1000, height: 500 }, { width: 1280, height: 640 }],
  ])("fits a %s playtest viewport within the initial window bounds", (_label, viewport, expected) => {
    expect(fitPlaytestContentSize(viewport)).toEqual(expected);
  });

  it("validates playtest viewport dimensions", () => {
    expect(isValidPlaytestViewport({ width: 1280, height: 720 })).toBe(true);
    expect(isValidPlaytestViewport({ width: 239, height: 720 })).toBe(false);
    expect(isValidPlaytestViewport({ width: 1280.5, height: 720 })).toBe(false);
    expect(isValidPlaytestViewport({ width: 1280, height: 8193 })).toBe(false);
    expect(isValidPlaytestViewport(null)).toBe(false);
  });

  it("limits sidebar window effects to windows that request them", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
    });
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      sidebarVibrancy: true,
    });

    const plain = electron.windows[0] as { options: Record<string, unknown> };
    const sidebar = electron.windows[1] as { options: Record<string, unknown> };
    if (process.platform === "darwin") {
      expect(plain.options.transparent).toBeUndefined();
      expect(plain.options.vibrancy).toBeUndefined();
      expect(sidebar.options.transparent).toBe(true);
      expect(sidebar.options.vibrancy).toBe("sidebar");
    } else {
      expect(plain.options.transparent).toBeUndefined();
      expect(sidebar.options.transparent).toBeUndefined();
    }
  });

  it("uses a single integrated title and menu bar for the Windows main window", async () => {
    await createDesktopWindow({
      runtime: { url: "http://127.0.0.1:43110", token: "token" },
      preloadPath: "/tmp/preload.cjs",
      rendererUrl: "http://127.0.0.1:43120",
      integratedMenuBar: true,
    });

    const window = electron.windows[0] as { options: Record<string, unknown> };
    if (process.platform === "win32") {
      expect(window.options).toMatchObject({
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#f7f7f7", symbolColor: "#202020", height: 32 },
      });
    } else if (process.platform === "darwin") {
      expect(window.options.titleBarStyle).toBe("hiddenInset");
      expect(window.options.titleBarOverlay).toBeUndefined();
    } else {
      expect(window.options.titleBarStyle).toBeUndefined();
      expect(window.options.titleBarOverlay).toBeUndefined();
    }
  });
});
