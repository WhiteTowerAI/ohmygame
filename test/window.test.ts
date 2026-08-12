import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({
  BrowserWindow: class {
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (event: { preventDefault(): void }, url: string) => void) => {
        if (event === "will-navigate") this.onNavigate = handler;
      }),
    };
    readonly once = vi.fn();
    readonly loadURL = vi.fn(async () => {});
    onNavigate?: (event: { preventDefault(): void }, url: string) => void;

    constructor() { electron.windows.push(this); }
    show() {}
  },
}));

import { createDesktopWindow } from "../src/desktop/window.js";

beforeEach(() => { electron.windows.length = 0; });

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
});
