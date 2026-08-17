import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { startDaemon, type ManagedDaemon } from "./daemon-process.js";
import { isOAuthAuthorizationUrl, OAuthCallbackFlow } from "./oauth.js";
import { createDesktopWindow, waitForRenderer } from "./window.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentRendererUrl = process.env.OPEN_GAME_RENDERER_URL ?? "http://127.0.0.1:43120";
const useBuiltRenderer = app.isPackaged || process.argv.includes("--built-renderer");
let daemon: ManagedDaemon | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
const oauth = new OAuthCallbackFlow(() => mainWindow?.webContents.send("open-game:auth-callback"));

ipcMain.handle("open-game:open-auth-url", async (_event, url: unknown) => {
  if (typeof url !== "string" || !isOAuthAuthorizationUrl(url)) throw new Error("Invalid OAuth authorization URL");
  await shell.openExternal(url);
});
ipcMain.handle("open-game:take-auth-callback", () => oauth.takeCallback());
ipcMain.handle("open-game:auth-callback-url", () => oauth.callbackUrl());
ipcMain.handle("open-game:cancel-auth", () => oauth.cancel());
ipcMain.handle("open-game:capture-page", async (event, rectangle: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Invalid capture source");
  const bounds = captureBounds(rectangle, mainWindow.getContentBounds());
  return mainWindow.webContents.capturePage(bounds).then((image) => image.toPNG());
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting || !daemon) return;
  event.preventDefault();
  quitting = true;
  void Promise.all([daemon.stop(), oauth.cancel()]).finally(() => app.quit());
});

try {
  await app.whenReady();
  const rendererOrigin = useBuiltRenderer ? "null" : new URL(developmentRendererUrl).origin;
  daemon = await startDaemon({
    daemonEntry: path.join(moduleDirectory, "../daemon/server.js"),
    dataDirectory: process.env.OPEN_GAME_DATA_DIR ?? path.join(app.getPath("userData"), "data"),
    token: randomBytes(32).toString("base64url"),
    allowedOrigins: [rendererOrigin],
    runtimeBin: app.isPackaged ? path.join(process.resourcesPath, "runtime/node/bin") : undefined,
    environment: app.isPackaged ? packagedEnvironment() : undefined,
  });

  if (!useBuiltRenderer) await waitForRenderer(developmentRendererUrl);
  mainWindow = await createDesktopWindow({
    runtime: daemon.runtime,
    preloadPath: path.join(moduleDirectory, "preload.cjs"),
    rendererUrl: useBuiltRenderer ? undefined : developmentRendererUrl,
    rendererFile: useBuiltRenderer ? path.join(moduleDirectory, "../renderer/index.html") : undefined,
  });
  mainWindow.once("closed", () => { mainWindow = undefined; });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  if (app.isReady()) dialog.showErrorBox("OpenGame could not start", message);
  await Promise.all([daemon?.stop(), oauth.cancel()]);
  app.exit(1);
}

function packagedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (environment.PUBLISH_API_URL) return environment;
  const config = JSON.parse(readFileSync(path.join(process.resourcesPath, "desktop-config.json"), "utf8")) as {
    publishApiUrl?: unknown;
  };
  if (typeof config.publishApiUrl === "string" && config.publishApiUrl) {
    environment.PUBLISH_API_URL = config.publishApiUrl;
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
