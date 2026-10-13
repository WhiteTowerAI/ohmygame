import { previewPagePath, previewPageUrl } from "../shared/preview-page.js";
import { BrowserWindow, WebContentsView, shell, type BaseWindow } from "electron";
import type { WebGamePlayerRequest, WebGamePlayerState, WebGamePreviewLayout } from "../shared/web-game-player.js";
import { webGamePlayerUrl } from "../shared/web-game-player.js";

interface EditorAttachment extends WebGamePreviewLayout {
  id: string;
  window: BrowserWindow;
  requestedPath: string;
}
interface Game {
  ready: Promise<void>;
  navigation: Promise<void>;
  view?: WebContentsView;
  parent?: BaseWindow;
  editor?: EditorAttachment;
  window?: BrowserWindow;
  opening?: Promise<void>;
  origin?: string;
  client?: string;
  title?: string;
  lastUrl?: string;
  crashed?: boolean;
  error?: string;
  fullscreen?: boolean;
}

export interface WebGamePlayerTarget {
  url: string;
  title: string;
}

/** One human game per project; Preview and Play move the same native view. */
export class WebGamePlayerWindows {
  readonly #games = new Map<string, Game>();

  constructor(private readonly onState: (state: WebGamePlayerState) => void, private readonly hostUrl: string) {}

  state(projectId: string): WebGamePlayerState {
    const game = this.#games.get(projectId);
    return { projectId, open: !!(game?.window || game?.opening), client: game?.client, error: game?.error };
  }

  async attach(projectId: string, attachment: string, editor: BrowserWindow, url: string, layout: WebGamePreviewLayout, resolveTarget: () => Promise<WebGamePlayerTarget>): Promise<void> {
    const game = this.#ensure(projectId, url, resolveTarget);
    const requestedPath = previewPagePath(url);
    const changed = game.editor?.id === attachment && game.editor.requestedPath !== requestedPath;
    const editorAttachment = { ...layout, id: attachment, window: editor, requestedPath };
    game.editor = editorAttachment;
    this.#place(game);
    await game.ready;
    if (this.#games.get(projectId) !== game || game.editor !== editorAttachment) return;
    // Reattaching an editor to a running Play window must not reset its route.
    if (new URL(url).origin !== game.origin) {
      const target = await resolveTarget();
      if (this.#games.get(projectId) !== game || game.editor !== editorAttachment) return;
      webGamePlayerUrl(target.url, url);
      const path = changed ? requestedPath : previewPagePath(this.#currentUrl(game));
      game.origin = new URL(target.url).origin;
      await this.#navigate(game, previewPageUrl(webGamePlayerUrl(target.url, path), game.window ? "player" : "editor", game.client));
    } else if (changed && previewPagePath(this.#currentUrl(game)) !== requestedPath) {
      await this.#navigate(game, previewPageUrl(webGamePlayerUrl(game.origin!, url), game.window ? "player" : "editor", game.client));
    }
    this.#place(game);
    this.onState(this.state(projectId));
  }

  layout(projectId: string, attachment: string, layout: WebGamePreviewLayout): void {
    const game = this.#games.get(projectId);
    if (!game?.editor || game.editor.id !== attachment) return;
    Object.assign(game.editor, layout);
    this.#place(game);
  }

  detach(projectId: string, attachment: string): void {
    const game = this.#games.get(projectId);
    if (!game?.editor || game.editor.id !== attachment) return;
    game.editor = undefined;
    if (game.window || game.opening) this.#place(game);
    else this.#dispose(projectId, game);
  }

  async capture(projectId: string): Promise<Uint8Array> {
    const game = this.#games.get(projectId);
    if (!game) throw new Error("The game preview is unavailable.");
    await game.ready;
    await game.navigation;
    if (this.#games.get(projectId) !== game || !game.view || game.crashed) throw new Error("The game preview is unavailable.");
    return (await game.view.webContents.capturePage()).toPNG();
  }

  async open(projectId: string, request: WebGamePlayerRequest, resolveTarget: () => Promise<WebGamePlayerTarget>): Promise<void> {
    const game = this.#ensure(projectId, request.path, resolveTarget);
    if (!game.window && !game.opening) {
      game.opening = Promise.resolve().then(async () => {
        await game.ready;
        await game.navigation;
        if (this.#games.get(projectId) !== game) throw new Error("Game launch was cancelled.");
        // Exit HTML fullscreen/pointer lock while this view still belongs to its old window.
        await this.#source(game, "player");
        if (this.#games.get(projectId) !== game) throw new Error("Game launch was cancelled.");
        const window = new BrowserWindow({
          width: request.viewport.width, height: request.viewport.height,
          useContentSize: true, minWidth: 240, minHeight: 240,
          show: false, title: `${game.title} - Play`, autoHideMenuBar: true,
          backgroundColor: "#000000",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        game.window = window;
        window.on("resize", () => this.#place(game));
        window.on("minimize", () => this.#place(game));
        window.on("restore", () => this.#place(game));
        // Detach before the native window closes; its game survives in Preview.
        window.on("close", (event) => {
          if (game.fullscreen && this.#games.get(projectId) === game) {
            event.preventDefault();
            void this.#source(game, "editor").then(() => {
              game.fullscreen = false;
              if (!window.isDestroyed()) window.close();
            });
          } else this.#return(projectId, game, window);
        });
        game.fullscreen = false;
        this.#place(game);
      }).catch((error) => {
        if (!game.editor) this.#dispose(projectId, game);
        throw error;
      }).finally(() => {
        game.opening = undefined;
        this.onState(this.state(projectId));
      });
      this.onState(this.state(projectId));
    }
    await game.opening;
    const window = game.window;
    if (!window || window.isDestroyed()) throw new Error("The game window was closed.");
    if (window.isMinimized()) window.restore();
    window.show();
    this.#place(game);
    window.focus();
    game.view?.webContents.focus();
    await game.view?.webContents.executeJavaScript("document.querySelector('iframe')?.focus()");
  }

  async refresh(projectId: string, resolveTarget: () => Promise<WebGamePlayerTarget>, reload = false): Promise<void> {
    const game = this.#games.get(projectId);
    if (!game) return;
    await game.ready;
    await game.navigation.catch(() => {});
    if (this.#games.get(projectId) !== game) return;
    const target = await resolveTarget();
    if (this.#games.get(projectId) !== game) return;
    const current = this.#currentUrl(game);
    const base = new URL(target.url);
    if (!reload && !game.crashed && new URL(current).origin === base.origin) return;
    const url = previewPageUrl(webGamePlayerUrl(base.href, previewPagePath(current)), game.window ? "player" : "editor", game.client);
    game.origin = new URL(url).origin;
    await this.#navigate(game, url);
    this.onState(this.state(projectId));
  }

  closeProject(projectId: string): void {
    const game = this.#games.get(projectId);
    if (game?.window) game.window.close();
    else if (game?.opening) this.#dispose(projectId, game);
  }

  synchronize(): void {
    for (const game of this.#games.values()) this.#place(game);
  }

  close(): void {
    for (const [projectId, game] of this.#games) this.#dispose(projectId, game);
  }

  #ensure(projectId: string, requestedUrl: string, resolveTarget: () => Promise<WebGamePlayerTarget>): Game {
    const existing = this.#games.get(projectId);
    if (existing) return existing;
    const game: Game = { ready: Promise.resolve(), navigation: Promise.resolve() };
    this.#games.set(projectId, game);
    game.ready = Promise.resolve().then(async () => {
      try {
        const target = await resolveTarget();
        if (this.#games.get(projectId) !== game) throw new Error("Game launch was cancelled.");
        const requested = new URL(requestedUrl, target.url);
        const url = previewPageUrl(webGamePlayerUrl(target.url, requested.href), game.editor ? "editor" : "player", requested.searchParams.get("__ohmygame_client") ?? undefined);
        game.origin = new URL(url).origin;
        game.client = new URL(url).searchParams.get("__ohmygame_client")!;
        game.title = target.title;
        const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        game.view = view;
        view.setBackgroundColor("#000000");
        const contents = view.webContents;
        contents.setWindowOpenHandler(({ url: destination }) => {
          if (/^https?:\/\//.test(destination)) void shell.openExternal(destination);
          return { action: "deny" };
        });
        contents.on("will-frame-navigate", (event) => {
          if (event.isMainFrame || new URL(event.url).origin !== game.origin) event.preventDefault();
        });
        contents.on("will-redirect", (event, destination, _inPlace, isMainFrame) => {
          if (isMainFrame || new URL(destination).origin !== game.origin) event.preventDefault();
        });
        contents.on("render-process-gone", () => {
          if (this.#games.get(projectId) !== game) return;
          game.crashed = true;
          game.fullscreen = false;
          game.error = "The game process stopped. Refresh the preview to restart it.";
          this.onState(this.state(projectId));
        });
        contents.on("enter-html-full-screen", () => {
          const window = game.parent;
          if (!window || window.isDestroyed() || game.fullscreen) return;
          // Electron restores the window's pre-existing native fullscreen state.
          game.fullscreen = true;
          this.#place(game);
        });
        contents.on("leave-html-full-screen", () => {
          game.fullscreen = false;
          this.#place(game);
        });
        const rememberRoute = () => {
          const frame = this.#frame(game);
          if (frame) game.lastUrl = frame.url;
        };
        contents.on("did-frame-navigate", rememberRoute);
        contents.on("did-navigate-in-page", rememberRoute);
        this.#place(game);
        await contents.loadURL(this.hostUrl);
        await this.#load(game, url);
        if (this.#games.get(projectId) !== game) throw new Error("Game launch was cancelled.");
      } catch (error) {
        this.#dispose(projectId, game);
        throw error;
      }
    });
    return game;
  }

  #currentUrl(game: Game): string {
    return this.#frame(game)?.url ?? game.lastUrl!;
  }

  #frame(game: Game) {
    try {
      return game.view?.webContents.mainFrame.frames.find((frame) => new URL(frame.url).origin === game.origin);
    } catch { return undefined; }
  }

  async #load(game: Game, url: string): Promise<void> {
    if (game.crashed) {
      await game.view!.webContents.loadURL(this.hostUrl);
      game.crashed = false;
    }
    game.lastUrl = url;
    await game.view!.webContents.executeJavaScript(`window.loadGame(${JSON.stringify(url)})`);
  }

  #navigate(game: Game, url: string): Promise<void> {
    const next = game.navigation.catch(() => {}).then(() => {
      if (!game.view || game.view.webContents.isDestroyed()) throw new Error("The game preview is unavailable.");
      return this.#load(game, url).then(() => {
        game.error = undefined;
        return this.#source(game, game.window ? "player" : "editor");
      });
    });
    game.navigation = next;
    return next;
  }

  async #source(game: Game, source: "editor" | "player"): Promise<void> {
    try {
      const frame = this.#frame(game);
      await frame?.executeJavaScript(`(async () => { document.exitPointerLock(); if (document.fullscreenElement) await document.exitFullscreen(); window.dispatchEvent(new CustomEvent('ohmygame:preview-source', { detail: ${JSON.stringify(source)} })); })()`);
    } catch { /* A navigation or crashed game will report its context after refresh. */ }
  }

  #place(game: Game): void {
    if (!game.view || game.view.webContents.isDestroyed()) return;
    const parent = game.window ?? game.editor?.window;
    if (game.parent !== parent) {
      if (game.parent && !game.parent.isDestroyed()) game.parent.contentView.removeChildView(game.view);
      game.parent = parent;
      if (parent && !parent.isDestroyed()) parent.contentView.addChildView(game.view);
    }
    let visible = false;
    if (parent && !parent.isDestroyed()) {
      const [width, height] = parent.getContentSize();
      if (game.window || game.fullscreen) {
        game.view.setBounds({ x: 0, y: 0, width, height });
        visible = parent.isVisible() && !parent.isMinimized();
      } else if (game.editor) {
        const zoom = game.editor.window.webContents.getZoomFactor();
        const input = game.editor.bounds;
        const x = Math.max(0, Math.min(width, Math.round(input.x * zoom)));
        const y = Math.max(0, Math.min(height, Math.round(input.y * zoom)));
        game.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(input.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(input.height * zoom))) });
        visible = game.editor.visible && input.width > 0 && input.height > 0 && parent.isVisible() && !parent.isMinimized();
      }
    }
    game.view.setVisible(visible);
    game.view.webContents.setAudioMuted(!visible);
  }

  #return(projectId: string, game: Game, window: BaseWindow): void {
    if (this.#games.get(projectId) !== game || game.window !== window) return;
    game.fullscreen = false;
    game.window = undefined;
    if (game.editor) {
      this.#place(game);
      void this.#source(game, "editor");
      this.onState({ ...this.state(projectId), open: false });
    } else this.#dispose(projectId, game);
  }

  #dispose(projectId: string, game: Game): void {
    if (this.#games.get(projectId) !== game) return;
    this.#games.delete(projectId);
    game.fullscreen = false;
    if (game.view) {
      if (game.parent && !game.parent.isDestroyed()) game.parent.contentView.removeChildView(game.view);
      if (!game.view.webContents.isDestroyed()) game.view.webContents.close({ waitForBeforeUnload: false });
    }
    game.window?.destroy();
    this.onState(this.state(projectId));
  }
}
