import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DaemonRuntime } from "./daemon-process.js";

interface CreateWindowOptions {
  runtime: DaemonRuntime;
  preloadPath: string;
  rendererUrl?: string;
  rendererFile?: string;
}

export async function createDesktopWindow(options: CreateWindowOptions): Promise<BrowserWindow> {
  const rendererTarget = options.rendererUrl
    ? new URL(options.rendererUrl).href
    : options.rendererFile
      ? pathToFileURL(path.resolve(options.rendererFile)).href
      : undefined;
  if (!rendererTarget) throw new Error("A renderer URL or file is required");

  const runtimeArguments = [
    `--open-game-daemon-url=${options.runtime.url}`,
    `--open-game-daemon-token=${options.runtime.token}`,
  ];
  const macWindowOptions = process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 18, y: 24 },
      }
    : {};
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#111214",
    show: false,
    ...macWindowOptions,
    webPreferences: {
      preload: path.resolve(options.preloadPath),
      additionalArguments: runtimeArguments,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererTarget) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());

  await window.loadURL(rendererTarget);

  return window;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function waitForRenderer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Vite may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Renderer did not become ready within ${timeoutMs}ms`);
}
