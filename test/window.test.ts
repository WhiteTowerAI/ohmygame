import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ windows: [] as unknown[], openExternal: vi.fn(async () => {}) }));

vi.mock("electron", () => ({
  shell: { openExternal: electron.openExternal },
  BrowserWindow: class {
    readonly webContents = {
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
        this.onWindowOpen = handler;
      }),
      on: vi.fn((event: string, handler: (event: { preventDefault(): void }, url: string) => void) => {
        if (event === "will-navigate") this.onNavigate = handler;
      }),
    };
    readonly once = vi.fn();
    readonly loadURL = vi.fn(async () => {});
    onNavigate?: (event: { preventDefault(): void }, url: string) => void;
    onWindowOpen?: (details: { url: string }) => { action: string };

    constructor() { electron.windows.push(this); }
    show() {}
  },
}));

import { createDesktopWindow } from "../src/desktop/window.js";

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
});
