import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

// The sandboxed preload is CommonJS that may only require Electron, so it runs
// here against a stub of the two Electron modules it uses.
const preloadSource = transformSync(
  readFileSync(new URL("../src/desktop/preload.cts", import.meta.url), "utf8"),
  { loader: "ts", format: "cjs" },
).code;

function runPreload(options: {
  runtime?: unknown;
  isMainFrame?: boolean;
  argv?: string[];
  platform?: NodeJS.Platform;
}) {
  const exposed = new Map<string, unknown>();
  const sendSync = vi.fn(() => options.runtime);
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api),
    },
    ipcRenderer: {
      sendSync,
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
  };
  const require = (id: string) => {
    if (id !== "electron") throw new Error(`Unexpected preload module: ${id}`);
    return electron;
  };
  const process = {
    platform: options.platform ?? "darwin",
    isMainFrame: options.isMainFrame ?? true,
    argv: options.argv ?? [],
  };
  const module = { exports: {} };
  const run = () =>
    new Function("require", "process", "module", "exports", preloadSource)(
      require,
      process,
      module,
      module.exports,
    );
  return { exposed, sendSync, invoke: electron.ipcRenderer.invoke, run };
}

describe("desktop preload", () => {
  it("asks the main process for the daemon runtime instead of reading the command line", () => {
    const preload = runPreload({
      runtime: { url: "http://127.0.0.1:43110", token: "secret-token" },
      argv: [
        "--ohmygame-daemon-url=http://127.0.0.1:1",
        "--ohmygame-daemon-token=stale",
      ],
    });

    preload.run();

    expect(preload.sendSync).toHaveBeenCalledWith("ohmygame:desktop-runtime");
    const desktop = preload.exposed.get("ohMyGameDesktop") as {
      runtime: { daemonUrl: string; token: string };
    };
    expect(desktop.runtime).toEqual({
      daemonUrl: "http://127.0.0.1:43110",
      token: "secret-token",
    });
    expect(Object.isFrozen(desktop.runtime)).toBe(true);
  });

  it.each([
    null,
    {},
    { url: "http://127.0.0.1:43110" },
    { url: "", token: "secret-token" },
  ])("refuses to start without a complete runtime %j", (runtime) => {
    const preload = runPreload({ runtime });

    expect(preload.run).toThrow("Missing desktop runtime");
    expect(preload.exposed.size).toBe(0);
  });

  it("passes the application menu's labels to the main process", () => {
    const preload = runPreload({
      runtime: { url: "http://127.0.0.1:43110", token: "secret-token" },
    });

    preload.run();
    const desktop = preload.exposed.get("ohMyGameDesktop") as {
      windowMenu: {
        setLabels(labels: Record<string, string>): unknown;
      };
    };
    void desktop.windowMenu.setLabels({ undo: "撤销" });

    expect(preload.invoke).toHaveBeenCalledWith("ohmygame:set-application-menu-labels", { undo: "撤销" });
  });

  it("sends the window control commands to the main process", () => {
    const preload = runPreload({
      runtime: { url: "http://127.0.0.1:43110", token: "secret-token" },
      platform: "win32",
    });

    preload.run();
    const desktop = preload.exposed.get("ohMyGameDesktop") as {
      windowControls: {
        minimize(): unknown;
        toggleMaximize(): unknown;
        close(): unknown;
        state(): unknown;
      };
    };
    void desktop.windowControls.minimize();
    void desktop.windowControls.toggleMaximize();
    void desktop.windowControls.close();
    void desktop.windowControls.state();

    expect(preload.invoke.mock.calls).toEqual([
      ["ohmygame:window-control", "minimize"],
      ["ohmygame:window-control", "toggle-maximize"],
      ["ohmygame:window-control", "close"],
      ["ohmygame:window-state"],
    ]);
  });

  it("keeps the window controls to Windows", () => {
    const preload = runPreload({
      runtime: { url: "http://127.0.0.1:43110", token: "secret-token" },
    });

    preload.run();

    expect(preload.exposed.get("ohMyGameDesktop")).not.toHaveProperty("windowControls");
  });

  it("exposes nothing to embedded frames", () => {
    const preload = runPreload({ isMainFrame: false });

    preload.run();

    expect(preload.sendSync).not.toHaveBeenCalled();
    expect(preload.exposed.size).toBe(0);
  });
});


it("exposes background settings only on supported desktop platforms", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const preload = runPreload({ runtime: { url: "http://localhost", token: "test" }, platform });
    preload.run();
    const api = preload.exposed.get("ohMyGameDesktop") as { backgroundRunning?: { get(): unknown; set(enabled: boolean): unknown } };
    if (platform === "linux") expect(api.backgroundRunning).toBeUndefined();
    else {
      api.backgroundRunning!.get();
      api.backgroundRunning!.set(true);
      expect(preload.invoke.mock.calls.slice(-2)).toEqual([["ohmygame:background-running"], ["ohmygame:background-running", true]]);
    }
  }
});
