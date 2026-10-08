import { BrowserWindow, shell } from "electron";
import type { WebGamePlayerRequest, WebGamePlayerState } from "../shared/web-game-player.js";
import { webGamePlayerUrl } from "../shared/web-game-player.js";

interface PlayerWindow {
  ready: Promise<BrowserWindow>;
  window?: BrowserWindow;
  origin?: string;
}

export interface WebGamePlayerTarget {
  url: string;
  title: string;
}

/** Human players have one window per project, independent of agent-owned test sessions. */
export class WebGamePlayerWindows {
  readonly #players = new Map<string, PlayerWindow>();

  constructor(private readonly onState: (state: WebGamePlayerState) => void) {}

  state(projectId: string): WebGamePlayerState {
    return { projectId, open: this.#players.has(projectId) };
  }

  async open(projectId: string, request: WebGamePlayerRequest, resolveTarget: () => Promise<WebGamePlayerTarget>): Promise<void> {
    let player = this.#players.get(projectId);
    if (!player) {
      // Register before resolving the server so concurrent clicks share the same launch.
      player = { ready: Promise.resolve().then(() => this.#create(projectId, player!, request, resolveTarget)) };
      this.#players.set(projectId, player);
      this.onState(this.state(projectId));
    }
    const window = await player.ready;
    if (window.isDestroyed()) throw new Error("The game window was closed.");
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  async refresh(projectId: string, resolveTarget: () => Promise<WebGamePlayerTarget>, reload = false): Promise<void> {
    const player = this.#players.get(projectId);
    if (!player) return;
    const window = await player.ready;
    if (window.isDestroyed()) return;
    const target = await resolveTarget();
    if (window.isDestroyed()) return;
    const current = new URL(window.webContents.getURL());
    const base = new URL(target.url);
    if (!reload && current.origin === base.origin) return;
    const url = webGamePlayerUrl(base.href, `${current.pathname}${current.search}${current.hash}`);
    player.origin = new URL(url).origin;
    await window.loadURL(url);
  }

  close(): void {
    for (const [projectId, player] of this.#players) {
      this.#players.delete(projectId);
      player.window?.destroy();
      this.onState(this.state(projectId));
    }
  }

  async #create(projectId: string, player: PlayerWindow, request: WebGamePlayerRequest, resolveTarget: () => Promise<WebGamePlayerTarget>): Promise<BrowserWindow> {
    try {
      const target = await resolveTarget();
      if (this.#players.get(projectId) !== player) throw new Error("Game launch was cancelled.");
      const url = webGamePlayerUrl(target.url, request.path);
      player.origin = new URL(url).origin;
      const window = new BrowserWindow({
        width: request.viewport.width,
        height: request.viewport.height,
        useContentSize: true,
        minWidth: 240,
        minHeight: 240,
        show: false,
        title: `${target.title} - Play`,
        autoHideMenuBar: true,
        backgroundColor: "#000000",
        // Use the same human storage as the editor iframe. AI tests have their own partitions.
        // Game pages receive neither the editor preload nor its daemon credentials.
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      player.window = window;
      window.once("closed", () => this.#forget(projectId, player));
      window.webContents.setWindowOpenHandler(({ url: destination }) => {
        if (/^https?:\/\//.test(destination)) void shell.openExternal(destination);
        return { action: "deny" };
      });
      const keepOrigin = (event: { preventDefault(): void }, destination: string) => {
        if (new URL(destination).origin !== player.origin) event.preventDefault();
      };
      window.webContents.on("will-navigate", keepOrigin);
      window.webContents.on("will-redirect", keepOrigin);
      await window.loadURL(url);
      return window;
    } catch (error) {
      player.window?.destroy();
      this.#forget(projectId, player);
      throw error;
    }
  }

  #forget(projectId: string, player: PlayerWindow): void {
    if (this.#players.get(projectId) !== player) return;
    this.#players.delete(projectId);
    this.onState(this.state(projectId));
  }
}
