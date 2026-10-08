import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron";
import { clipboardFilePaths, loadClipboardFiles } from "./file-clipboard.js";
import { startDaemon, type ManagedDaemon } from "./daemon-process.js";
import { isOAuthAuthorizationUrl, OAuthCallbackFlow } from "./oauth.js";
import { applySystemProxy } from "./system-proxy.js";
import { createDesktopWindow, fitPlaytestContentSize, isValidPlaytestViewport, waitForRenderer } from "./window.js";
import { DesktopUpdater } from "./updater.js";
import { ElectronPlaytestDriver } from "./playtest-driver.js";
import { WebGamePlayerWindows, type WebGamePlayerTarget } from "./web-game-player.js";
import { PROJECT_FILE_OPEN_MODES, type ProjectFileOpenMode } from "../shared/contracts.js";
import type { PlaytestWatchState } from "../shared/playtest.js";
import type { WebGamePlayerRequest } from "../shared/web-game-player.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../..");
const developmentRendererUrl = process.env.OHMYGAME_RENDERER_URL ?? "http://127.0.0.1:43120";
const useBuiltRenderer = app.isPackaged || process.argv.includes("--built-renderer");
let daemon: ManagedDaemon | undefined;
let mainWindow: BrowserWindow | undefined;
const playtestWindows = new Map<string, BrowserWindow | Promise<BrowserWindow>>();
/** A Node that fails to start never reports back; its window gives up after this. */
const NODE_THUMBNAIL_TIMEOUT_MS = 20_000;
/** Hidden Node thumbnail windows by WebContents ID. */
const nodeThumbnails = new Map<number, { window: BrowserWindow; finish: (captured: boolean) => void }>();
let nodeThumbnailQueue: Promise<unknown> = Promise.resolve();
/** Thumbnail windows run Node code, so they may only capture and report. */
const NODE_THUMBNAIL_CHANNELS = new Set(["ohmygame:capture-page", "ohmygame:finish-node-thumbnail"]);

function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (nodeThumbnails.has(event.sender.id) && !NODE_THUMBNAIL_CHANNELS.has(channel)) {
      throw new Error("Invalid thumbnail request");
    }
    return listener(event, ...args);
  });
}
const agentPlaytests = new ElectronPlaytestDriver((state) => {
  mainWindow?.webContents.send("ohmygame:agent-playtest-state", state);
});
const webGamePlayers = new WebGamePlayerWindows((state) => {
  mainWindow?.webContents.send("ohmygame:web-game-player-state", state);
});
let quitting = false;
let updater: DesktopUpdater | undefined;
const oauth = new OAuthCallbackFlow(() => mainWindow?.webContents.send("ohmygame:auth-callback"));
const windowMenuLabels = new Set(["File", "Edit", "View", "Window"]);
let applicationIconDataUrl: Promise<string> | undefined;

async function stopServices(): Promise<void> {
  webGamePlayers.close();
  agentPlaytests.close();
  await Promise.all([daemon?.stop(), oauth.cancel()]);
}

async function openProjectFile(filePath: string, mode: ProjectFileOpenMode): Promise<void> {
  if (mode === "reveal") {
    shell.showItemInFolder(filePath);
    return;
  }
  if (mode === "default") {
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    return;
  }
  if (process.platform === "darwin") {
    const application = mode === "vscode" ? "Visual Studio Code" : mode === "zed" ? "Zed" : "TextEdit";
    await executeFile("/usr/bin/open", ["-a", application, filePath]);
    return;
  }
  if (mode === "text-editor") {
    if (process.platform !== "win32") throw new Error("A system text editor is not available on this platform");
    await executeFile("notepad.exe", [filePath]);
    return;
  }
  const target = new URL(`${mode}://file`);
  target.pathname = filePath.replaceAll("\\", "/");
  await shell.openExternal(target.toString());
}

function executeFile(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => error ? reject(error) : resolve());
  });
}

handle("ohmygame:open-auth-url", async (_event, url: unknown) => {
  if (typeof url !== "string" || !isOAuthAuthorizationUrl(url)) throw new Error("Invalid OAuth authorization URL");
  await shell.openExternal(url);
});
handle("ohmygame:take-auth-callback", () => oauth.takeCallback());
handle("ohmygame:auth-callback-url", () => oauth.callbackUrl());
handle("ohmygame:cancel-auth", () => oauth.cancel());
handle("ohmygame:clipboard-files", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid clipboard source");
  const paths = await clipboardFilePaths(clipboard);
  const files = await loadClipboardFiles(paths);
  if (paths.length && !files.length) throw new Error("The copied folder does not contain any files.");
  return files;
});
handle("ohmygame:paste-native", (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid clipboard source");
  event.sender.paste();
});
handle("ohmygame:set-appearance", (event, appearance: unknown) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow.isDestroyed()) throw new Error("Invalid appearance source");
  if (appearance !== "system" && appearance !== "light" && appearance !== "dark") {
    throw new Error("Invalid appearance");
  }
  nativeTheme.themeSource = appearance;
  const isDark = appearance === "dark" || (appearance === "system" && nativeTheme.shouldUseDarkColors);
  if (process.platform === "win32" && senderWindow.setTitleBarOverlay) {
    senderWindow.setTitleBarOverlay({
      color: isDark ? "#1f1f1f" : "#f9f0f3",
      symbolColor: isDark ? "#ffffff" : "#202020",
      height: 32,
    });
  }
});
handle("ohmygame:window-menu-icon", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid window menu source");
  applicationIconDataUrl ??= app.getFileIcon(process.execPath, { size: "small" }).then((icon) => icon.toDataURL());
  return applicationIconDataUrl;
});
handle("ohmygame:popup-window-menu", (event, label: unknown, x: unknown, y: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof label !== "string" ||
      !windowMenuLabels.has(label) || typeof x !== "number" || !Number.isFinite(x) ||
      typeof y !== "number" || !Number.isFinite(y)) {
    throw new Error("Invalid window menu request");
  }
  const item = Menu.getApplicationMenu()?.items.find((candidate) => candidate.label.replaceAll("&", "") === label);
  if (!item?.submenu) throw new Error(`Window menu is not available: ${label}`);
  item.submenu.popup({ window: mainWindow, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) });
});
handle("ohmygame:browse-plugin-directory", async (event, pluginId: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid browse source");
  if (!validRouteId(pluginId) || !daemon) throw new Error("Invalid plugin");
  const response = await fetch(`${daemon.runtime.url}/plugins/${encodeURIComponent(pluginId)}/directory`, {
    headers: { authorization: `Bearer ${daemon.runtime.token}` },
  });
  if (!response.ok) throw new Error("Plugin directory is not available");
  const result = await response.json() as { path?: unknown };
  if (typeof result.path !== "string" || !path.isAbsolute(result.path)) throw new Error("Invalid plugin directory");
  const error = await shell.openPath(result.path);
  if (error) throw new Error(error);
});
handle("ohmygame:open-project-file", async (event, projectId: unknown, filePath: unknown, mode: unknown = "default") => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid file open source");
  if (!validRouteId(projectId) || typeof filePath !== "string" || !filePath || filePath.length > 1_000 ||
    typeof mode !== "string" || !PROJECT_FILE_OPEN_MODES.includes(mode as ProjectFileOpenMode) || !daemon) {
    throw new Error("Invalid project file");
  }
  const response = await fetch(`${daemon.runtime.url}/projects/${encodeURIComponent(projectId)}/files/location?path=${encodeURIComponent(filePath)}`, {
    headers: { authorization: `Bearer ${daemon.runtime.token}` },
  });
  if (!response.ok) throw new Error("Project file is not available");
  const result = await response.json() as { path?: unknown };
  if (typeof result.path !== "string" || !path.isAbsolute(result.path)) throw new Error("Invalid project file path");
  await openProjectFile(result.path, mode as ProjectFileOpenMode);
});
handle("ohmygame:reveal-plugin-skill", async (event, pluginId: unknown, skillId: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid browse source");
  if (!validRouteId(pluginId) || typeof skillId !== "string" || !skillId || skillId.length > 1_000 || !daemon) {
    throw new Error("Invalid Plugin Skill");
  }
  const response = await fetch(`${daemon.runtime.url}/plugins/${encodeURIComponent(pluginId)}/skill-file?id=${encodeURIComponent(skillId)}`, {
    headers: { authorization: `Bearer ${daemon.runtime.token}` },
  });
  if (!response.ok) throw new Error("Plugin Skill is not available");
  const result = await response.json() as { path?: unknown };
  if (typeof result.path !== "string" || !path.isAbsolute(result.path)) throw new Error("Invalid Plugin Skill path");
  shell.showItemInFolder(result.path);
});
handle("ohmygame:select-plugin-directory", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid directory selection source");
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});
handle("ohmygame:select-project-directory", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid directory selection source");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select project workspace",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});
handle("ohmygame:capture-page", async (event, rectangle: unknown) => {
  const window = mainWindow && event.sender === mainWindow.webContents
    ? mainWindow
    : nodeThumbnails.get(event.sender.id)?.window;
  if (!window) throw new Error("Invalid capture source");
  const bounds = captureBounds(rectangle, window.getContentBounds());
  return window.webContents.capturePage(bounds).then((image) => image.toPNG());
});
handle("ohmygame:capture-node-thumbnail", (event, projectId: unknown, nodeId: unknown, viewport: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid thumbnail source");
  if (!validRouteId(projectId) || !validRouteId(nodeId) || !isValidPlaytestViewport(viewport)) throw new Error("Invalid thumbnail target");
  // One hidden window at a time keeps background captures cheap.
  const capture = nodeThumbnailQueue.then(() => captureNodeThumbnail(projectId, nodeId, viewport));
  nodeThumbnailQueue = capture.catch(() => {});
  return capture;
});
handle("ohmygame:finish-node-thumbnail", (event, captured: unknown) => {
  nodeThumbnails.get(event.sender.id)?.finish(captured === true);
});
handle("ohmygame:agent-playtest-state", (event): PlaytestWatchState => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid Agent playtest source");
  return agentPlaytests.watchState();
});
handle("ohmygame:set-agent-playtest-visible", (event, visible: unknown): PlaytestWatchState => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof visible !== "boolean") {
    throw new Error("Invalid Agent playtest visibility");
  }
  return agentPlaytests.setVisible(visible);
});
handle("ohmygame:web-game-player-state", (event, projectId: unknown) => {
  requirePlayerSource(event.sender, projectId);
  return webGamePlayers.state(projectId);
});
handle("ohmygame:open-web-game-player", (event, projectId: unknown, request: unknown) => {
  requirePlayerSource(event.sender, projectId);
  const input = request as Partial<WebGamePlayerRequest> | null;
  if (!input || typeof input.path !== "string" || input.path.length > 2_000 || !isValidPlaytestViewport(input.viewport)) {
    throw new Error("Invalid game player target");
  }
  return webGamePlayers.open(projectId, input as WebGamePlayerRequest, () => resolvePlayerTarget(projectId));
});
handle("ohmygame:refresh-web-game-player", (event, projectId: unknown, reload: unknown = false) => {
  requirePlayerSource(event.sender, projectId);
  if (typeof reload !== "boolean") throw new Error("Invalid game player refresh");
  return webGamePlayers.refresh(projectId, () => resolvePlayerTarget(projectId), reload);
});

function requirePlayerSource(sender: Electron.WebContents, projectId: unknown): asserts projectId is string {
  if (!mainWindow || sender !== mainWindow.webContents || !validRouteId(projectId) || !daemon) {
    throw new Error("Invalid game player source");
  }
}

async function resolvePlayerTarget(projectId: string): Promise<WebGamePlayerTarget> {
  if (!daemon) throw new Error("The game service is unavailable.");
  const headers = { authorization: `Bearer ${daemon.runtime.token}` };
  const response = await fetch(`${daemon.runtime.url}/projects/${encodeURIComponent(projectId)}/preview?reuse=1`, { method: "POST", headers });
  const result = await response.json() as { url?: string; title?: string; error?: string; message?: string };
  if (!response.ok || !result.url || !result.title) throw new Error(result.message ?? result.error ?? "The game server could not start.");
  return { url: result.url, title: result.title };
}

handle("ohmygame:open-playtest", async (event, projectId: unknown, viewport: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid playtest source");
  if (!validRouteId(projectId) || !isValidPlaytestViewport(viewport) || !daemon) throw new Error("Invalid playtest target");
  const size = fitPlaytestContentSize(viewport);
  const aspectRatio = viewport.width / viewport.height;
  const current = playtestWindows.get(projectId);
  if (current) {
    const existing = await current;
    if (!existing.isDestroyed()) {
      existing.setAspectRatio(aspectRatio);
      existing.setContentSize(size.width, size.height);
      existing.focus();
      return;
    }
    playtestWindows.delete(projectId);
  }
  const opening = createDesktopWindow({
    runtime: daemon.runtime,
    preloadPath: path.join(moduleDirectory, "preload.cjs"),
    rendererUrl: useBuiltRenderer ? undefined : developmentRendererUrl,
    rendererFile: useBuiltRenderer ? path.join(moduleDirectory, "../renderer/index.html") : undefined,
    rendererHash: `#/playtest/${encodeURIComponent(projectId)}`,
    contentSize: size,
    aspectRatio,
    minWidth: Math.max(1, Math.round(size.width / 2)),
    minHeight: Math.max(1, Math.round(size.height / 2)),
  });
  playtestWindows.set(projectId, opening);
  try {
    const playtest = await opening;
    if (!mainWindow) {
      playtest.close();
      return;
    }
    playtestWindows.set(projectId, playtest);
    playtest.once("closed", () => {
      if (playtestWindows.get(projectId) === playtest) playtestWindows.delete(projectId);
    });
  } catch (error) {
    if (playtestWindows.get(projectId) === opening) playtestWindows.delete(projectId);
    throw error;
  }
});
handle("ohmygame:open-playable-node", async (event, projectId: unknown, nodeId: unknown) => {
  if (!validRouteId(projectId) || !validRouteId(nodeId)) throw new Error("Invalid Node target");
  const playtest = await playtestWindows.get(projectId);
  if (!playtest || playtest.isDestroyed() || event.sender !== playtest.webContents) throw new Error("Invalid Node source");
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("ohmygame:open-playable-node", projectId, nodeId);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
handle("ohmygame:update-state", () => updater?.state() ?? null);
handle("ohmygame:check-for-update", () => updater?.check());
handle("ohmygame:download-update", () => updater?.download());
handle("ohmygame:install-update", () => updater?.install());

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !daemon) return;
  event.preventDefault();
  quitting = true;
  void stopServices().finally(() => app.quit());
});

try {
  await app.whenReady();
  nativeTheme.themeSource = "system";
  const rendererOrigin = useBuiltRenderer ? "null" : new URL(developmentRendererUrl).origin;
  daemon = await startDaemon({
    daemonEntry: path.join(moduleDirectory, "../daemon/server.js"),
    dataDirectory: process.env.OHMYGAME_DATA_DIR ?? path.join(app.getPath("userData"), "data"),
    token: randomBytes(32).toString("base64url"),
    allowedOrigins: [rendererOrigin],
    piAgentDirectory: process.env.PI_CODING_AGENT_DIR ?? path.join(app.getPath("userData"), "pi-agent"),
    bundledPluginsDirectory: app.isPackaged ? path.join(process.resourcesPath, "plugins") : undefined,
    preinstalledPluginsDirectory: app.isPackaged
      ? path.join(process.resourcesPath, "preinstalled-plugins")
      : path.join(repositoryRoot, ".runtime", "preinstalled-plugins"),
    examplesDirectory: app.isPackaged
      ? path.join(process.resourcesPath, "examples")
      : path.join(repositoryRoot, ".runtime", "examples"),
    runtimeBin: app.isPackaged
      ? process.platform === "win32"
        ? path.join(process.resourcesPath, "runtime", "node")
        : path.join(process.resourcesPath, "runtime", "node", "bin")
      : undefined,
    environment: app.isPackaged ? await packagedEnvironment() : undefined,
    development: !useBuiltRenderer,
    healthTimeoutMs: 30_000,
    handlePlaytestRequest: (request, signal) => agentPlaytests.request(request, signal),
  });
  updater = new DesktopUpdater(app.getVersion(), async () => {
    await stopServices();
    quitting = true;
  });

  if (!useBuiltRenderer) await waitForRenderer(developmentRendererUrl);
  mainWindow = await createDesktopWindow({
    runtime: daemon.runtime,
    preloadPath: path.join(moduleDirectory, "preload.cjs"),
    rendererUrl: useBuiltRenderer ? undefined : developmentRendererUrl,
    rendererFile: useBuiltRenderer ? path.join(moduleDirectory, "../renderer/index.html") : undefined,
    sidebarVibrancy: true,
    integratedMenuBar: true,
    beforeLoad: (window) => { mainWindow = window; },
  });
  updater.subscribe((state) => mainWindow?.webContents.send("ohmygame:update-state", state));
  if (app.isPackaged) void updater.check();
  mainWindow.once("closed", () => {
    mainWindow = undefined;
    webGamePlayers.close();
    for (const playtest of playtestWindows.values()) {
      void Promise.resolve(playtest).then((window) => window.close(), () => {});
    }
    playtestWindows.clear();
    for (const thumbnail of nodeThumbnails.values()) thumbnail.finish(false);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  if (app.isReady()) dialog.showErrorBox("OhMyGame could not start", message);
  await stopServices();
  app.exit(1);
}

async function packagedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = { ...process.env };
  // esbuild spawns a native binary, which cannot run from inside app.asar.
  environment.ESBUILD_BINARY_PATH ??= packagedEsbuildBinary();
  try {
    await applySystemProxy(environment, (url) => session.defaultSession.resolveProxy(url));
  } catch (error) {
    console.warn("Could not resolve the system proxy", error);
  }
  if (!environment.CLOUD_API_URL && !environment.PUBLISH_API_URL) {
    const config = JSON.parse(readFileSync(path.join(process.resourcesPath, "desktop-config.json"), "utf8")) as {
      cloudApiUrl?: unknown;
      publishApiUrl?: unknown;
    };
    const cloudApiUrl = typeof config.cloudApiUrl === "string" && config.cloudApiUrl
      ? config.cloudApiUrl
      : typeof config.publishApiUrl === "string" && config.publishApiUrl ? config.publishApiUrl : undefined;
    if (cloudApiUrl) {
      environment.CLOUD_API_URL = cloudApiUrl;
    }
  }
  return environment;
}

function captureBounds(value: unknown, content: Electron.Rectangle): Electron.Rectangle {
  if (!value || typeof value !== "object") throw new Error("Invalid capture bounds");
  const candidate = value as Partial<Electron.Rectangle>;
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) {
    throw new Error("Invalid capture bounds");
  }
  const bounds = {
    x: Math.max(0, Math.round(candidate.x!)),
    y: Math.max(0, Math.round(candidate.y!)),
    width: Math.round(candidate.width!),
    height: Math.round(candidate.height!),
  };
  if (bounds.width < 1 || bounds.height < 1 || bounds.width > 4096 || bounds.height > 4096 ||
      bounds.x + bounds.width > content.width || bounds.y + bounds.height > content.height) {
    throw new Error("Invalid capture bounds");
  }
  return bounds;
}

/**
 * Runs one Node in a hidden window. The page stores its own screenshot, with
 * the hash of what it ran, and then reports whether that worked.
 */
async function captureNodeThumbnail(projectId: string, nodeId: string, viewport: { width: number; height: number }): Promise<boolean> {
  if (!daemon || !mainWindow) return false;
  let finish!: (captured: boolean) => void;
  const finished = new Promise<boolean>((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish(false), NODE_THUMBNAIL_TIMEOUT_MS);
  let thumbnailWindow: BrowserWindow | undefined;
  try {
    const opening = createDesktopWindow({
      runtime: daemon.runtime,
      preloadPath: path.join(moduleDirectory, "preload.cjs"),
      rendererUrl: useBuiltRenderer ? undefined : developmentRendererUrl,
      rendererFile: useBuiltRenderer ? path.join(moduleDirectory, "../renderer/index.html") : undefined,
      rendererHash: `#/thumbnail/${encodeURIComponent(projectId)}/${encodeURIComponent(nodeId)}`,
      contentSize: fitPlaytestContentSize(viewport),
      minWidth: 1,
      minHeight: 1,
      hidden: true,
      beforeLoad: (window) => {
        thumbnailWindow = window;
        const id = window.webContents.id;
        nodeThumbnails.set(id, { window, finish });
        window.once("closed", () => { nodeThumbnails.delete(id); finish(false); });
      },
    });
    const captured = await Promise.race([opening.then(() => finished), finished]);
    return captured;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (thumbnailWindow && !thumbnailWindow.isDestroyed()) thumbnailWindow.destroy();
  }
}

function validRouteId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("/");
}

function packagedEsbuildBinary(): string {
  // Resolve the platform package from esbuild's own directory, as esbuild does, because packaging
  // may nest it when another dependency brings a different esbuild version.
  const esbuildPackage = createRequire(import.meta.url).resolve("esbuild/package.json");
  const platformPackage = createRequire(esbuildPackage).resolve(`@esbuild/${process.platform}-${process.arch}/package.json`);
  const packageDirectory = path.dirname(platformPackage)
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return path.join(packageDirectory, process.platform === "win32" ? "esbuild.exe" : path.join("bin", "esbuild"));
}
