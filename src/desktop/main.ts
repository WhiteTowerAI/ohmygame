import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, dialog, ipcMain, nativeTheme, session, shell, type BrowserWindow } from "electron";
import { startDaemon, type ManagedDaemon } from "./daemon-process.js";
import { isOAuthAuthorizationUrl, OAuthCallbackFlow } from "./oauth.js";
import { applySystemProxy } from "./system-proxy.js";
import { createDesktopWindow, fitPlaytestContentSize, isValidPlaytestViewport, waitForRenderer } from "./window.js";
import { DesktopUpdater } from "./updater.js";
import { ElectronPlaytestDriver } from "./playtest-driver.js";
import type { PlaytestWatchState } from "../shared/playtest.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../..");
const developmentRendererUrl = process.env.OHMYGAME_RENDERER_URL ?? "http://127.0.0.1:43120";
const useBuiltRenderer = app.isPackaged || process.argv.includes("--built-renderer");
let daemon: ManagedDaemon | undefined;
let mainWindow: BrowserWindow | undefined;
const playtestWindows = new Map<string, BrowserWindow | Promise<BrowserWindow>>();
const agentPlaytests = new ElectronPlaytestDriver((state) => {
  mainWindow?.webContents.send("ohmygame:agent-playtest-state", state);
});
let quitting = false;
let updater: DesktopUpdater | undefined;
const oauth = new OAuthCallbackFlow(() => mainWindow?.webContents.send("ohmygame:auth-callback"));

async function stopServices(): Promise<void> {
  agentPlaytests.close();
  await Promise.all([daemon?.stop(), oauth.cancel()]);
}

ipcMain.handle("ohmygame:open-auth-url", async (_event, url: unknown) => {
  if (typeof url !== "string" || !isOAuthAuthorizationUrl(url)) throw new Error("Invalid OAuth authorization URL");
  await shell.openExternal(url);
});
ipcMain.handle("ohmygame:take-auth-callback", () => oauth.takeCallback());
ipcMain.handle("ohmygame:auth-callback-url", () => oauth.callbackUrl());
ipcMain.handle("ohmygame:cancel-auth", () => oauth.cancel());
ipcMain.handle("ohmygame:browse-plugin-directory", async (event, pluginId: unknown) => {
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
ipcMain.handle("ohmygame:reveal-plugin-skill", async (event, pluginId: unknown, skillId: unknown) => {
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
ipcMain.handle("ohmygame:select-plugin-directory", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid directory selection source");
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
});
ipcMain.handle("ohmygame:select-project-directory", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid directory selection source");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select project workspace",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});
ipcMain.handle("ohmygame:capture-page", async (event, rectangle: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid capture source");
  const bounds = captureBounds(rectangle, mainWindow.getContentBounds());
  return mainWindow.webContents.capturePage(bounds).then((image) => image.toPNG());
});
ipcMain.handle("ohmygame:agent-playtest-state", (event): PlaytestWatchState => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid Agent playtest source");
  return agentPlaytests.watchState();
});
ipcMain.handle("ohmygame:set-agent-playtest-visible", (event, visible: unknown): PlaytestWatchState => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof visible !== "boolean") {
    throw new Error("Invalid Agent playtest visibility");
  }
  return agentPlaytests.setVisible(visible);
});
ipcMain.handle("ohmygame:open-playtest", async (event, projectId: unknown, chapterId: unknown, viewport: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid playtest source");
  if (!validRouteId(projectId) || !validRouteId(chapterId) || !isValidPlaytestViewport(viewport) || !daemon) throw new Error("Invalid playtest target");
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
    rendererHash: `#/playtest/${encodeURIComponent(projectId)}/${encodeURIComponent(chapterId)}`,
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
ipcMain.handle("ohmygame:update-state", () => updater?.state() ?? null);
ipcMain.handle("ohmygame:check-for-update", () => updater?.check());
ipcMain.handle("ohmygame:download-update", () => updater?.download());
ipcMain.handle("ohmygame:install-update", () => updater?.install());

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
    piAgentDirectory: path.join(app.getPath("userData"), "pi-agent"),
    bundledPluginsDirectory: app.isPackaged ? path.join(process.resourcesPath, "plugins") : undefined,
    preinstalledPluginsDirectory: app.isPackaged
      ? path.join(process.resourcesPath, "preinstalled-plugins")
      : path.join(repositoryRoot, ".runtime", "preinstalled-plugins"),
    runtimeBin: app.isPackaged
      ? process.platform === "win32"
        ? path.join(process.resourcesPath, "runtime", "node")
        : path.join(process.resourcesPath, "runtime", "node", "bin")
      : undefined,
    environment: app.isPackaged ? await packagedEnvironment() : undefined,
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
  });
  updater.subscribe((state) => mainWindow?.webContents.send("ohmygame:update-state", state));
  if (app.isPackaged) void updater.check();
  mainWindow.once("closed", () => {
    mainWindow = undefined;
    for (const playtest of playtestWindows.values()) {
      void Promise.resolve(playtest).then((window) => window.close(), () => {});
    }
    playtestWindows.clear();
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

function validRouteId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("/");
}
