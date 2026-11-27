import { BrowserWindow, screen } from "electron";
import {
  GAME_SIGN_IN_WINDOW_OPTIONS,
  guardGameSignInWindow,
  isGameSignInRequest,
} from "./game-sign-in.js";
import { openInBrowser } from "./open-in-browser.js";
import { installZoomShortcuts } from "./application-menu.js";

/**
 * Community games the person moved out of the app into windows of their own,
 * one per game, so they can keep playing while they browse. A window shows the
 * game's published page and nothing else: no preload, a sandbox, and the same
 * session as the in-app player, so a game's saves carry over between the two.
 * Its page may not navigate to another site; links go to the system browser,
 * and only the account service's sign-in may open a window, as in the app.
 */

/** The address a published game plays at: HTTPS, or loopback from local publishing. */
export function communityPlayUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === "https:") return url.href;
    return url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** A short title for the window; the game's own page may change it. */
function windowTitle(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : "OhMyGame";
}

export class CommunityGameWindows {
  readonly #windows = new Map<string, BrowserWindow>();

  constructor(
    private readonly onChange: (gameId: string, open: boolean) => void,
    /** The account service published games sign in with, once the network is known. */
    private readonly signInIssuer: () => string | undefined = () => undefined,
  ) {}

  /** Opens the game's window, or brings it forward if it is open already. */
  async open(
    gameId: string,
    playUrl: unknown,
    title: unknown,
    near?: BrowserWindow,
  ): Promise<void> {
    const url = communityPlayUrl(playUrl);
    if (!url) throw new Error("Invalid game address");
    const existing = this.#windows.get(gameId);
    if (existing && !existing.isDestroyed()) {
      this.#show(existing);
      return;
    }
    const display =
      near && !near.isDestroyed()
        ? screen.getDisplayMatching(near.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = Math.min(
      1,
      (display.workAreaSize.width * 0.85) / 1280,
      (display.workAreaSize.height * 0.85) / 720,
    );
    const window = new BrowserWindow({
      width: Math.round(1280 * scale),
      height: Math.round(720 * scale),
      useContentSize: true,
      minWidth: 320,
      minHeight: 240,
      show: false,
      title: windowTitle(title),
      autoHideMenuBar: true,
      backgroundColor: "#000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.#windows.set(gameId, window);
    this.onChange(gameId, true);
    const contents = window.webContents;
    installZoomShortcuts(contents);
    const origin = new URL(url).origin;
    contents.setWindowOpenHandler((details) => {
      if (isGameSignInRequest(details, this.signInIssuer()))
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            ...GAME_SIGN_IN_WINDOW_OPTIONS,
            parent: window,
          },
        };
      if (/^https?:\/\//.test(details.url)) void openInBrowser(details.url);
      return { action: "deny" };
    });
    contents.on("did-create-window", (child) => guardGameSignInWindow(child));
    // The game stays on its own site; anywhere else opens in the browser.
    contents.on("will-navigate", (event, destination) => {
      if (sameOrigin(destination, origin)) return;
      event.preventDefault();
      if (/^https?:\/\//.test(destination)) void openInBrowser(destination);
    });
    contents.on(
      "will-redirect",
      (event, destination, _inPlace, isMainFrame) => {
        if (isMainFrame && !sameOrigin(destination, origin))
          event.preventDefault();
      },
    );
    window.once("ready-to-show", () => this.#show(window));
    window.on("closed", () => {
      if (this.#windows.get(gameId) !== window) return;
      this.#windows.delete(gameId);
      this.onChange(gameId, false);
    });
    try {
      await contents.loadURL(url);
    } catch (error) {
      // Closing the window or navigating inside the game can interrupt its first load.
      if (
        window.isDestroyed() ||
        (error as NodeJS.ErrnoException).code === "ERR_ABORTED"
      )
        return;
      window.destroy();
      throw error;
    }
  }

  isOpen(gameId: string): boolean {
    return this.#windows.has(gameId);
  }

  close(gameId: string): void {
    const window = this.#windows.get(gameId);
    if (window && !window.isDestroyed()) window.close();
  }

  closeAll(): void {
    for (const window of this.#windows.values())
      if (!window.isDestroyed()) window.close();
  }

  #show(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}
