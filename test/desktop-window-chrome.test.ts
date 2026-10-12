import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  appEvents: new Map<string, (...args: any[]) => void>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  themeListeners: [] as Array<() => void>,
  theme: { source: "system" as "system" | "light" | "dark", systemDark: false },
  windows: [] as any[],
  sender: { id: 1, send: vi.fn() },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    on: (name: string, fn: (...args: any[]) => void) =>
      host.appEvents.set(name, fn),
    whenReady: async () => {},
    getPath: () => "/tmp/ohmygame-window-chrome-test",
    getVersion: () => "0.0.0",
    isReady: () => true,
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) =>
      host.handlers.set(name, fn),
    on: vi.fn(),
  },
  nativeTheme: {
    get themeSource() {
      return host.theme.source;
    },
    set themeSource(value: "system" | "light" | "dark") {
      host.theme.source = value;
    },
    get shouldUseDarkColors() {
      return host.theme.systemDark;
    },
    on: (event: string, listener: () => void) => {
      if (event === "updated") host.themeListeners.push(listener);
    },
  },
  session: {
    fromPartition: () => ({ setProxy: async () => {} }),
    defaultSession: { setProxy: async () => {} },
  },
  BrowserWindow: Object.assign(
    class {
      readonly options: Record<string, unknown>;
      readonly setTitleBarOverlay = vi.fn();
      readonly loadURL = vi.fn(async () => {});
      readonly setAspectRatio = vi.fn();
      readonly once = vi.fn();
      readonly on = vi.fn();
      readonly show = vi.fn();
      readonly close = vi.fn();
      readonly webContents = {
        id: 1,
        send: host.sender.send,
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        setAudioMuted: vi.fn(),
      };

      constructor(options: Record<string, unknown>) {
        this.options = options;
        host.windows.push(this);
      }
      isDestroyed(): boolean {
        return false;
      }
    },
    {
      fromWebContents: () => host.windows.at(-1),
      getAllWindows: () => host.windows,
    },
  ),
  clipboard: {},
  dialog: { showErrorBox: vi.fn() },
  Menu: {},
  shell: {},
}));
vi.mock("undici/index.js", () => ({ setGlobalDispatcher: vi.fn() }));
vi.doMock(path.resolve("src/daemon/environment.ts"), () => ({
  loadEnvironmentFiles: vi.fn(),
}));
vi.doMock(path.resolve("src/daemon/proxy.ts"), () => ({
  createNetworkDispatcher: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/network.ts"), () => ({
  prepareDesktopNetwork: async () => ({ active: {}, environment: {} }),
  electronProxyConfig: () => ({}),
  proxyCredentials: vi.fn(),
}));
vi.doMock(path.resolve("src/desktop/daemon-process.ts"), () => ({
  startDaemon: async () => ({
    runtime: { url: "http://127.0.0.1:12345", token: "test" },
    stop: async () => {},
  }),
}));
vi.doMock(path.resolve("src/desktop/oauth.ts"), () => ({
  isOAuthAuthorizationUrl: vi.fn(),
  OAuthCallbackFlow: class {
    cancel = async () => {};
  },
}));
vi.doMock(path.resolve("src/desktop/playtest-driver.ts"), () => ({
  ElectronPlaytestDriver: class {
    close() {}
  },
}));
vi.doMock(path.resolve("src/desktop/web-game-player.ts"), () => ({
  WebGamePlayerWindows: class {
    close() {}
  },
}));
vi.doMock(path.resolve("src/desktop/updater.ts"), () => ({
  DesktopUpdater: class {
    subscribe() {}
    check() {}
  },
}));

const DARK_CONTROLS = { color: "#1f1f1f", symbolColor: "#ffffff", height: 32 };
const LIGHT_CONTROLS = { color: "#f7f7f7", symbolColor: "#202020", height: 32 };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  host.appEvents.clear();
  host.handlers.clear();
  host.themeListeners.length = 0;
  host.theme = { source: "system", systemDark: false };
  host.windows.length = 0;
  process.argv.push("--built-renderer");
  await import("../src/desktop/main.js");
  expect(host.windows).toHaveLength(1);
});
afterEach(() => {
  process.argv.splice(process.argv.lastIndexOf("--built-renderer"), 1);
  vi.unstubAllGlobals();
});

const mainWindow = () =>
  host.windows.at(-1) as { setTitleBarOverlay: ReturnType<typeof vi.fn> };
const chooseAppearance = (appearance: "system" | "light" | "dark") =>
  host.handlers.get("ohmygame:set-appearance")!(
    { sender: host.sender },
    appearance,
  );
const systemThemeChanged = () => {
  for (const listener of host.themeListeners) listener();
};

it("darkens the Windows window controls when the renderer requests the dark appearance", () => {
  chooseAppearance("dark");

  expect(mainWindow().setTitleBarOverlay).toHaveBeenCalledWith(DARK_CONTROLS);
});

it("lightens the Windows window controls when the renderer requests the light appearance", () => {
  host.theme.systemDark = true;
  chooseAppearance("light");

  expect(mainWindow().setTitleBarOverlay).toHaveBeenCalledWith(LIGHT_CONTROLS);
});

it.each([
  ["darkens", false, true],
  ["lightens", true, false],
] as const)(
  "%s the Windows window controls when the system theme changes under the system appearance",
  (_label, before, after) => {
    host.theme.systemDark = before;
    chooseAppearance("system");
    mainWindow().setTitleBarOverlay.mockClear();

    host.theme.systemDark = after;
    systemThemeChanged();

    expect(mainWindow().setTitleBarOverlay).toHaveBeenCalledWith(
      after ? DARK_CONTROLS : LIGHT_CONTROLS,
    );
  },
);

it("keeps the system appearance color while the system theme does not change", () => {
  host.theme.systemDark = true;
  chooseAppearance("system");

  systemThemeChanged();

  expect(mainWindow().setTitleBarOverlay).toHaveBeenCalledWith(DARK_CONTROLS);
});
