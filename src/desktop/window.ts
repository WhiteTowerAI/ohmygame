import { BrowserWindow, nativeTheme, screen } from "electron";
import { openInBrowser } from "./open-in-browser.js";
import { installZoomShortcuts } from "./application-menu.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DaemonRuntime } from "./daemon-process.js";
import { pluginFrameNavigationAllowed } from "../shared/plugin-ui-protocol.js";
import { embedNavigationAllowed, embedOrigin } from "../shared/library-embeds.js";
import { GAME_SIGN_IN_WINDOW_OPTIONS, guardGameSignInWindow, isGameSignInRequest } from "./game-sign-in.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../..");

interface CreateWindowOptions {
  runtime: DaemonRuntime;
  preloadPath: string;
  rendererUrl?: string;
  rendererFile?: string;
  rendererHash?: string;
  sidebarVibrancy?: boolean;
  /** Draws the window's controls in the app on Windows, in place of a native title bar. */
  integratedWindowControls?: boolean;
  contentSize?: { width: number; height: number };
  aspectRatio?: number;
  /** Keeps window controls and dragging outside the game surface. */
  nativeTitleBar?: boolean;
  minWidth?: number;
  minHeight?: number;
  /** Never shown or heard, and keeps rendering while hidden so it can be captured. */
  hidden?: boolean;
  /**
   * The account service's HTTPS base URL. Published games framed in this window may then
   * open its sign-in page in a popup; see game-sign-in.ts.
   */
  gameSignInIssuer?: string;
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

function defaultWindowBounds(minWidth = 960, minHeight = 640) {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1200, Math.floor(workArea.width * 0.9));
  const height = Math.min(780, Math.floor(workArea.height * 0.88));
  return {
    width,
    height,
    minWidth: Math.min(minWidth, width),
    minHeight: Math.min(minHeight, height),
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
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

  const platformWindowOptions = process.platform === "darwin" && !options.nativeTitleBar
    ? {
        titleBarStyle: "hiddenInset" as const,
        ...(options.sidebarVibrancy ? {
          // The buttons' circles start 2px inside this box, so y: 16 centres
          // them on the 48px title bar's middle (24px), with its tabs.
          trafficLightPosition: { x: 24, y: 16 },
          backgroundColor: "#00000000",
          transparent: true,
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
        } : {}),
      }
    : process.platform === "win32" && options.integratedWindowControls
      ? { titleBarStyle: "hidden" as const }
    : {};
  const window = new BrowserWindow({
    icon: path.resolve(repositoryRoot, "build/icon.ico"),
    ...(options.contentSize ? {
      ...options.contentSize,
      minWidth: options.minWidth ?? 960,
      minHeight: options.minHeight ?? 640,
      useContentSize: true,
    } : defaultWindowBounds(options.minWidth, options.minHeight)),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171717" : "#ffffff",
    show: false,
    ...platformWindowOptions,
    webPreferences: {
      preload: path.resolve(options.preloadPath),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.hidden ? { backgroundThrottling: false } : {}),
    },
  });
  if (options.aspectRatio) window.setAspectRatio(options.aspectRatio);
  // The preload asks for the daemon address and token instead of reading them
  // from its command line, which other processes of the same user can read.
  // Only the renderer page in this window receives them, not a frame embedded
  // in it or a page the window was redirected to. A window closing while its
  // page still asks is destroyed, and reading its webContents would throw.
  window.webContents.ipc.on("ohmygame:desktop-runtime", (event) => {
    const frame = event.senderFrame;
    event.returnValue = frame && !window.isDestroyed() && frame === window.webContents.mainFrame && isRendererPage(frame.url, rendererTarget)
      ? { url: options.runtime.url, token: options.runtime.token }
      : null;
  });

  window.webContents.setWindowOpenHandler((details) => {
    if (isGameSignInRequest(details, options.gameSignInIssuer))
      return { action: "allow", overrideBrowserWindowOptions: { ...GAME_SIGN_IN_WINDOW_OPTIONS, parent: window } };
    if (isExternalUrl(details.url)) void openInBrowser(details.url);
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (child) => guardGameSignInWindow(child));
  installZoomShortcuts(window.webContents);
  window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererPage(url, rendererTarget)) event.preventDefault();
  });
  // A page the Library embeds, such as a source's 3D viewer, stays on its own
  // site: going elsewhere inside the frame, by a link or a server redirect, is
  // refused, and its new-window links open in the browser as any page's do.
  // This keeps a named site from becoming another one inside the app; it does
  // not vet what that site shows, which the source's plugin chose. The frame
  // gets no preload or daemon token either way. The renderer names each origin
  // before loading it; only the window's own page may.
  const embedded = new Set<string>();
  // Where each frame's current navigation started, so a redirect is held to
  // the site it was meant for even on a frame's first load.
  const navigationStarts = new Map<number, string>();
  window.webContents.ipc.handle("ohmygame:library-embed", (event, url: unknown) => {
    const frame = event.senderFrame;
    const origin = typeof url === "string" ? embedOrigin(url) : undefined;
    if (!frame || frame !== window.webContents.mainFrame || !isRendererPage(frame.url, rendererTarget) || !origin)
      throw new Error("The Library can only embed an https page");
    embedded.add(origin);
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || !event.frame) return;
    if (!embedNavigationAllowed(event.frame.url, event.url, embedded)) event.preventDefault();
  });
  window.webContents.on("did-start-navigation", (event) => {
    if (event.isMainFrame || event.isSameDocument || !event.frame) return;
    navigationStarts.set(event.frame.frameTreeNodeId, event.url);
  });
  window.webContents.on("will-redirect", (event) => {
    if (event.isMainFrame || !event.frame) return;
    const start = navigationStarts.get(event.frame.frameTreeNodeId) ?? event.frame.url;
    if (!embedNavigationAllowed(event.frame.url, event.url, embedded) || !embedNavigationAllowed(start, event.url, embedded))
      event.preventDefault();
  });
  // A plugin page's frame stays within its own plugin's files.
  const pluginUiUrl = options.runtime.pluginUiUrl;
  if (pluginUiUrl)
    window.webContents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame || !event.frame) return;
      if (!pluginFrameNavigationAllowed(event.frame.url, event.url, pluginUiUrl)) event.preventDefault();
    });
  // A hidden window, such as an agent's playtest, runs the game out of
  // sight, so it must not be heard either.
  if (options.hidden) window.webContents.setAudioMuted(true);
  else window.once("ready-to-show", () => window.show());
  options.beforeLoad?.(window);

  await window.loadURL(loadTarget);

  return window;
}

function isRendererPage(value: string, rendererTarget: string): boolean {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href === rendererTarget;
  } catch {
    return false;
  }
}

/** A web page, or an email address the system's mail app opens. */
function isExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
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
