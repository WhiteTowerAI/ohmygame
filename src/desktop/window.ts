import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DaemonRuntime } from "./daemon-process.js";

const PLAYTEST_MAX_CONTENT_WIDTH = 1280;
const PLAYTEST_MAX_CONTENT_HEIGHT = 800;

interface CreateWindowOptions {
  runtime: DaemonRuntime;
  preloadPath: string;
  rendererUrl?: string;
  rendererFile?: string;
  rendererHash?: string;
  sidebarVibrancy?: boolean;
  /** Hosts the application menu in a single custom Windows title bar. */
  integratedMenuBar?: boolean;
  contentSize?: { width: number; height: number };
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
  /** Never shown or heard, and keeps rendering while hidden so it can be captured. */
  hidden?: boolean;
  /** Runs before the renderer loads, so the page can reach the window early. */
  beforeLoad?: (window: BrowserWindow) => void;
}

export function isValidPlaytestViewport(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== "object") return false;
  const viewport = value as { width?: unknown; height?: unknown };
  return Number.isInteger(viewport.width) && Number.isInteger(viewport.height) &&
    Number(viewport.width) >= 240 && Number(viewport.width) <= 8192 &&
    Number(viewport.height) >= 240 && Number(viewport.height) <= 8192;
}

export function fitPlaytestContentSize(viewport: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(PLAYTEST_MAX_CONTENT_WIDTH / viewport.width, PLAYTEST_MAX_CONTENT_HEIGHT / viewport.height);
  return {
    width: Math.round(viewport.width * scale),
    height: Math.round(viewport.height * scale),
  };
}

export async function createDesktopWindow(options: CreateWindowOptions): Promise<BrowserWindow> {
  const rendererTarget = options.rendererUrl
    ? new URL(options.rendererUrl).href
    : options.rendererFile
      ? pathToFileURL(path.resolve(options.rendererFile)).href
      : undefined;
  if (!rendererTarget) throw new Error("A renderer URL or file is required");
  const loadTarget = options.rendererHash ? `${rendererTarget}${options.rendererHash}` : rendererTarget;

  const runtimeArguments = [
    `--ohmygame-daemon-url=${options.runtime.url}`,
    `--ohmygame-daemon-token=${options.runtime.token}`,
  ];
  const platformWindowOptions = process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset" as const,
        ...(options.sidebarVibrancy ? {
          trafficLightPosition: { x: 24, y: 18 },
          backgroundColor: "#00000000",
          transparent: true,
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
        } : {}),
      }
    : process.platform === "win32" && options.integratedMenuBar
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#f7f7f7",
            symbolColor: "#202020",
            height: 32,
          },
        }
    : {};
  const window = new BrowserWindow({
    width: options.contentSize?.width ?? 1440,
    height: options.contentSize?.height ?? 900,
    minWidth: options.minWidth ?? 960,
    minHeight: options.minHeight ?? 640,
    ...(options.contentSize ? { useContentSize: true } : {}),
    backgroundColor: "#171717",
    show: false,
    ...platformWindowOptions,
    webPreferences: {
      preload: path.resolve(options.preloadPath),
      additionalArguments: runtimeArguments,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.hidden ? { backgroundThrottling: false } : {}),
    },
  });
  if (options.aspectRatio) window.setAspectRatio(options.aspectRatio);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (withoutHash(url) !== rendererTarget) event.preventDefault();
  });
  // A hidden window, such as a Scene thumbnail capture, runs the game out of
  // sight, so it must not be heard either.
  if (options.hidden) window.webContents.setAudioMuted(true);
  else window.once("ready-to-show", () => window.show());
  options.beforeLoad?.(window);

  await window.loadURL(loadTarget);

  return window;
}

function withoutHash(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
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
