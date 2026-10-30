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
    platform: "darwin",
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
  return { exposed, sendSync, run };
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

  it("exposes nothing to embedded frames", () => {
    const preload = runPreload({ isMainFrame: false });

    preload.run();

    expect(preload.sendSync).not.toHaveBeenCalled();
    expect(preload.exposed.size).toBe(0);
  });
});
