import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  appEvents: new Map<string, (...args: any[]) => void>(),
  ipcEvents: new Map<string, (...args: any[]) => void>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  windowEvents: new Map<string, (...args: any[]) => void>(),
  sender: { id: 1, mainFrame: {}, send: vi.fn(), on: vi.fn() },
  updateUsageData: vi.fn((enabled: boolean) => enabled),
  thumbnails: [] as Array<{ webContents: { id: number }; destroy: ReturnType<typeof vi.fn> }>,
  stopped: vi.fn(async () => {}),
  quit: vi.fn(), relaunch: vi.fn(), close: vi.fn(), hide: vi.fn(), show: vi.fn(), focus: vi.fn(),
  visible: true,
  dataDirectory: "",
  trayEvents: new Map<string, () => void>(),
  trayMenu: undefined as { template: Array<{ label: string; click: () => void }> } | undefined,
  trayDestroyed: false,
  getFileIcon: vi.fn(async () => ({ isEmpty: () => false })),
  install: undefined as (() => Promise<void>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  daemonOptions: undefined as Record<string, unknown> | undefined,
  applicationMenu: undefined as { template: Array<{ role?: string; label?: string }> } | undefined,
  menuBeforeLabels: undefined as { template: Array<{ role?: string; label?: string }> } | undefined,
  daemonGate: undefined as Promise<void> | undefined,
  mainWindows: 0,
  showErrorBox: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    on: (name: string, fn: (...args: any[]) => void) => host.appEvents.set(name, fn),
    whenReady: async () => {}, getPath: () => "/tmp/ohmygame-close-test", getVersion: () => "0.0.0",
    isReady: () => true, quit: host.quit, relaunch: host.relaunch, exit: vi.fn(),
    setAppUserModelId: vi.fn(), setBadgeCount: vi.fn(), getFileIcon: host.getFileIcon,
  },
  Tray: class {
    constructor() { host.trayDestroyed = false; }
    setToolTip() {}
    on(name: string, callback: () => void) { host.trayEvents.set(name, callback); }
    setContextMenu(menu: typeof host.trayMenu) { host.trayMenu = menu; }
    isDestroyed() { return host.trayDestroyed; }
    destroy() { host.trayDestroyed = true; }
  },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => host.handlers.set(name, fn),
    on: (name: string, fn: (...args: any[]) => void) => host.ipcEvents.set(name, fn),
  },
  nativeImage: { createFromBitmap: () => ({}) }, nativeTheme: {}, session: { fromPartition: () => ({ setProxy: async () => {} }), defaultSession: { setProxy: async () => {} } },
  BrowserWindow: { getAllWindows: () => [] }, clipboard: {}, dialog: { showErrorBox: host.showErrorBox }, shell: {},
  Menu: {
    buildFromTemplate: (template: Array<{ role?: string; label?: string }>) => ({ template }),
    setApplicationMenu: (menu: typeof host.applicationMenu) => { host.applicationMenu = menu; },
  },
}));
vi.mock("undici/index.js", () => ({ setGlobalDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/daemon/environment.ts"), () => ({ loadEnvironmentFiles: vi.fn() }));
vi.doMock(path.resolve("src/daemon/proxy.ts"), () => ({ createNetworkDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/desktop/usage-data.cts"), () => ({
  readUsageData: () => false, updateUsageData: host.updateUsageData,
}));
vi.doMock(path.resolve("src/desktop/network.ts"), () => ({
  prepareDesktopNetwork: async () => ({ active: {}, environment: {} }), electronProxyConfig: () => ({}), proxyCredentials: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/daemon-process.ts"), () => ({
  startDaemon: async (options: Record<string, unknown>) => {
    host.daemonOptions = options;
    await host.daemonGate;
    return { runtime: { url: "http://127.0.0.1:12345", token: "test" }, stop: host.stopped };
  },
}));
vi.doMock(path.resolve("src/desktop/log-file.ts"), () => ({
  RotatingLogFile: class { line() {} write() {} flush() {} close() {} stream() { return { write() {}, flush() {} }; } },
}));
vi.doMock(path.resolve("src/desktop/console-log.ts"), async (importOriginal) => ({
  ...(await importOriginal<object>()), recordConsole: vi.fn(), recordUncaughtErrors: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/external-mcp-install.ts"), () => ({ installExternalMcpLauncher: vi.fn(async () => undefined), markExternalMcpApp: vi.fn(async () => async () => {}) }));
vi.doMock(path.resolve("src/desktop/oauth.ts"), () => ({
  isOAuthAuthorizationUrl: vi.fn(), OAuthCallbackFlow: class { cancel = async () => {}; },
}));
vi.doMock(path.resolve("src/desktop/playtest-driver.ts"), () => ({ ElectronPlaytestDriver: class { close() {} } }));
vi.doMock(path.resolve("src/desktop/web-game-player.ts"), () => ({ WebGamePlayerWindows: class { close() {} } }));
vi.doMock(path.resolve("src/desktop/updater.ts"), () => ({ DesktopUpdater: class {
  constructor(_version: string, install: () => Promise<void>) { host.install = install; }
  subscribe() {} check() {}
}, DesktopUpdatePreparationError: class extends Error {} }));
vi.doMock(path.resolve("src/desktop/window.ts"), () => ({
  createDesktopWindow: async (options: { hidden?: boolean; beforeLoad(window: unknown): void }) => {
    host.options = options as unknown as Record<string, unknown>;
    if (options.hidden) {
      let destroyed = false;
      const events = new Map<string, () => void>();
      const window = {
        webContents: { id: host.thumbnails.length + 2 }, isDestroyed: () => destroyed,
        once: (name: string, listener: () => void) => events.set(name, listener),
        destroy: vi.fn(() => { destroyed = true; events.get("closed")?.(); }),
      };
      host.thumbnails.push(window);
      options.beforeLoad(window);
      return window;
    }
    const window = {
      hide: host.hide, show: host.show, focus: host.focus, isMinimized: () => false,
      isVisible: () => host.visible, isFocused: () => host.visible,
      webContents: host.sender, isDestroyed: () => false, close: host.close, setOverlayIcon: vi.fn(),
      on: (name: string, fn: (...args: any[]) => void) => host.windowEvents.set(name, fn),
      once: (name: string, fn: (...args: any[]) => void) => host.windowEvents.set(name, fn),
    };
    host.mainWindows += 1;
    options.beforeLoad(window);
    host.menuBeforeLabels = host.applicationMenu;
    // The page sends its labels as it loads, before the window has finished opening.
    host.handlers.get("ohmygame:set-application-menu-labels")!({ sender: host.sender }, { window: "Sent while loading" });
    return window;
  },
  waitForRenderer: async () => {}, fitPlaytestContentSize: vi.fn(), isValidPlaytestViewport: () => true,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  host.appEvents.clear(); host.ipcEvents.clear(); host.handlers.clear(); host.windowEvents.clear();
  host.dataDirectory = mkdtempSync(path.join(os.tmpdir(), "ohmygame-close-"));
  vi.stubEnv("OHMYGAME_DATA_DIR", host.dataDirectory);
  host.visible = true;
  host.hide.mockImplementation(() => { host.visible = false; });
  host.show.mockImplementation(() => { host.visible = true; });
  host.trayEvents.clear();
  host.trayMenu = undefined;
  host.thumbnails.length = 0;
  host.applicationMenu = undefined;
  host.menuBeforeLabels = undefined;
  host.daemonGate = undefined;
  host.mainWindows = 0;
  process.argv.push("--built-renderer");
  host.quit.mockImplementation(() => host.appEvents.get("before-quit")!({ preventDefault() {} }));
  await import("../src/desktop/main.js");
  expect(host.options?.rendererFile).toMatch(/[\\/]renderer[\\/]index\.html$/);
});
afterEach(() => { process.argv.splice(process.argv.lastIndexOf("--built-renderer"), 1); vi.useRealTimers(); vi.unstubAllEnvs(); Object.defineProperty(process, "platform", originalPlatform); rmSync(host.dataDirectory, { recursive: true, force: true }); });

const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
function acknowledge(error?: string, sender: { id: number; send: unknown } = host.sender, id?: number) {
  const sent = host.sender.send.mock.calls.findLast(([channel]) => channel === "ohmygame:prepare-close")!;
  host.ipcEvents.get("ohmygame:ready-to-close")!({ sender }, id ?? sent[1], error);
}
function quit() { const event = { preventDefault: vi.fn() }; host.appEvents.get("before-quit")!(event); expect(event.preventDefault).toHaveBeenCalledOnce(); }

const fileMenuLabel = () => host.applicationMenu!.template.find((item) => item.role === "fileMenu")!.label;

it("accepts usage data changes only from the main window's main frame", () => {
  const update = host.handlers.get("ohmygame:update-usage-data")!;
  expect(() => update({ sender: { id: 2 }, senderFrame: {} }, true, false)).toThrow("Invalid usage data request");
  expect(() => update({ sender: host.sender, senderFrame: {} }, true, false)).toThrow("Invalid usage data request");
  expect(update({ sender: host.sender, senderFrame: host.sender.mainFrame }, false, true)).toBe(false);
  expect(host.updateUsageData).toHaveBeenCalledExactlyOnceWith(false, true);
});

it("lets the built renderer frame plugin pages, which CSP knows as file: and CORS as null", () => {
  expect(host.daemonOptions).toMatchObject({ allowedOrigins: ["null"], pluginFrameAncestors: ["file:"] });
});
it("has an English application menu before the main window loads", () => {
  expect(host.menuBeforeLabels!.template.map((item) => item.label)).not.toContain("Sent while loading");
  expect(host.menuBeforeLabels!.template.find((item) => item.role === "fileMenu")).toEqual(expect.objectContaining({ label: undefined }));
});
it("lets only the main window relabel the application menu", async () => {
  const setLabels = host.handlers.get("ohmygame:set-application-menu-labels")!;
  expect(fileMenuLabel()).toBeUndefined();

  // A hidden thumbnail window runs Scene code.
  await expect((async () => setLabels({ sender: { id: 99 } }, { file: "Scene" }))()).rejects.toThrow("Invalid application menu labels");
  await expect((async () => setLabels({ sender: host.sender }, { file: 1 }))()).rejects.toThrow("Invalid application menu labels");
  expect(fileMenuLabel()).toBeUndefined();

  await setLabels({ sender: host.sender }, { file: "文件" });
  expect(fileMenuLabel()).toBe("文件");
});
it("accepts the labels the main window sends while it loads", () => {
  expect(host.applicationMenu!.template.find((item) => item.role === "windowMenu")!.label).toBe("Sent while loading");
});
it("ignores a macOS activate while the service is still starting", async () => {
  vi.resetModules(); host.appEvents.clear(); host.mainWindows = 0; host.daemonOptions = undefined;
  let release!: () => void;
  host.daemonGate = new Promise((resolve) => { release = resolve; });
  const starting = import("../src/desktop/main.js");
  await vi.waitFor(() => expect(host.daemonOptions).toBeDefined());
  // Relaunching the app after an update sends activate before startup opens its window.
  host.appEvents.get("activate")!();
  await settle();
  expect(host.showErrorBox).not.toHaveBeenCalled();
  expect(host.mainWindows).toBe(0);
  release(); await starting;
  expect(host.mainWindows).toBe(1);
  host.appEvents.get("activate")!();
  expect(host.mainWindows).toBe(1);
});
it("keeps services running until Quit receives a save acknowledgement", async () => {
  quit(); quit();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
  expect(host.quit).toHaveBeenCalledOnce();
});
it("saves before closing a window and shares that save with a concurrent Quit", async () => {
  const event = { preventDefault: vi.fn() };
  host.windowEvents.get("close")!(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(host.close).not.toHaveBeenCalled();
  quit(); acknowledge(); await settle();
  expect(host.sender.send).toHaveBeenCalledTimes(1);
  expect(host.close).not.toHaveBeenCalled();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("closes a saved macOS window while keeping the daemon alive", async () => {
  host.windowEvents.get("close")!({ preventDefault() {} });
  acknowledge(); await settle();
  expect(host.close).toHaveBeenCalledOnce();
  expect(host.stopped).not.toHaveBeenCalled();
});
it("cancels a failed Quit and permits a later retry", async () => {
  quit(); acknowledge("Resolve the board conflict before saving."); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.quit).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("conflict"));
  quit(); acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("rejects foreign and stale acknowledgements and resumes after a timeout", async () => {
  quit(); acknowledge(undefined, { id: 99, send: vi.fn() }); acknowledge(undefined, host.sender, 0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(host.stopped).not.toHaveBeenCalled();
  expect(host.sender.send).toHaveBeenLastCalledWith("ohmygame:cancel-close", 1, expect.stringContaining("too long"));
  quit(); acknowledge(undefined, host.sender, 1); await settle();
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("does not schedule a restart until its save succeeds", async () => {
  host.handlers.get("ohmygame:restart-app")!({ sender: host.sender });
  expect(host.relaunch).not.toHaveBeenCalled();
  acknowledge("Disk unavailable"); await settle();
  expect(host.relaunch).not.toHaveBeenCalled();
  host.handlers.get("ohmygame:restart-app")!({ sender: host.sender });
  acknowledge(); await settle();
  expect(host.relaunch).toHaveBeenCalledOnce();
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("requires the same save acknowledgement before installing an update", async () => {
  const installing = host.install!();
  expect(host.stopped).not.toHaveBeenCalled();
  acknowledge(); await installing;
  expect(host.stopped).toHaveBeenCalledOnce();
});
it("blocks an update when background services cannot stop safely", async () => {
  host.stopped.mockRejectedValueOnce(new Error("Service is still writing"));
  const installing = host.install!();
  acknowledge();
  await expect(installing).rejects.toThrow();
  expect(host.quit).not.toHaveBeenCalled();
});

it("cancels active and queued thumbnail captures and frees slots for the next batch", async () => {
  const capture = (id: string, batch: string) => host.handlers.get("ohmygame:capture-node-thumbnail")!(
    { sender: host.sender }, "p", id, { width: 1280, height: 720 }, batch,
  ) as Promise<unknown>;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const previous = [capture("a", "old"), capture("b", "old"), capture("c", "old")];
    expect(host.thumbnails).toHaveLength(2);
    host.handlers.get("ohmygame:cancel-node-thumbnails")!({ sender: host.sender }, "old");
    await expect(Promise.all(previous)).resolves.toEqual(Array(3).fill({ captured: false, error: "The capture was cancelled." }));
    expect(host.thumbnails.every(window => window.destroy.mock.calls.length === 1)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const next = capture("next", "new");
    expect(host.thumbnails).toHaveLength(3);
    host.handlers.get("ohmygame:finish-node-thumbnail")!({ sender: host.thumbnails[2]!.webContents }, true);
    await expect(next).resolves.toEqual({ captured: true });
    // A failure carries the hidden window's reason to the editor and the log.
    const failing = capture("broken", "new");
    host.handlers.get("ohmygame:finish-node-thumbnail")!({ sender: host.thumbnails[3]!.webContents }, false, "The preview could not start.");
    await expect(failing).resolves.toEqual({ captured: false, error: "The preview could not start." });
    expect(warn).toHaveBeenCalledExactlyOnceWith('Node thumbnail "broken" was not captured: The preview could not start.');
  } finally {
    warn.mockRestore();
  }
});


const background = (value?: unknown, event = { sender: host.sender, senderFrame: host.sender.mainFrame }) =>
  host.handlers.get("ohmygame:background-running")!(event, value) as Promise<boolean>;

it("hides without entering closing state and restores the same live window", async () => {
  expect(await background()).toBe(false);
  await background(true);
  host.windowEvents.get("close")!({ preventDefault() {} });
  expect(host.hide).toHaveBeenCalledOnce();
  expect(host.sender.send).not.toHaveBeenCalled();
  expect(host.close).not.toHaveBeenCalled();
  expect(host.stopped).not.toHaveBeenCalled();
  host.appEvents.get("second-instance")!();
  await settle();
  expect(host.show).toHaveBeenCalledOnce();
  expect(host.focus).toHaveBeenCalledOnce();
  expect(host.mainWindows).toBe(1);
  await background(false);
  host.windowEvents.get("close")!({ preventDefault() {} });
  acknowledge(); await settle();
  expect(host.close).toHaveBeenCalledOnce();
});

it("still saves on explicit Quit, and reopens a hidden window when saving fails", async () => {
  await background(true);
  host.windowEvents.get("close")!({ preventDefault() {} });
  quit(); acknowledge("Save conflict"); await settle();
  expect(host.visible).toBe(true);
  expect(host.stopped).not.toHaveBeenCalled();
  quit(); acknowledge(); await settle();
  expect(host.stopped).toHaveBeenCalledOnce();
});

it("rejects subframe, foreign and malformed background preferences", async () => {
  await expect(background(true, { sender: host.sender, senderFrame: {} })).rejects.toThrow("source");
  await expect(background("true")).rejects.toThrow("setting");
  expect(await background()).toBe(false);
});

it("creates a Windows tray with working restore, localized menu, and explicit Quit", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.resetModules();
    await import("../src/desktop/main.js");
    await background(true);
    expect(host.getFileIcon).toHaveBeenCalledWith(process.execPath, { size: "small" });
    host.windowEvents.get("close")!({ preventDefault() {} });
    host.trayEvents.get("click")!();
    await settle();
    expect(host.visible).toBe(true);
    host.handlers.get("ohmygame:set-application-menu-labels")!({ sender: host.sender }, { openApp: "打开 OhMyGame", quit: "退出" });
    expect(host.trayMenu!.template.map(item => item.label)).toEqual(["打开 OhMyGame", "退出"]);
    host.windowEvents.get("close")!({ preventDefault() {} });
    host.trayMenu!.template[0]!.click();
    await settle();
    expect(host.visible).toBe(true);
    host.trayMenu!.template[1]!.click();
    expect(host.stopped).not.toHaveBeenCalled();
    acknowledge(); await settle();
    expect(host.stopped).toHaveBeenCalledOnce();
    host.appEvents.get("will-quit")!();
    expect(host.trayDestroyed).toBe(true);
  } finally { Object.defineProperty(process, "platform", original); }
});
