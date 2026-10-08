import { useEffect, useRef, useState } from "react";
import { ensureProjectPreview } from "./api.js";
import { webGamePlayerUrl, type WebGamePlayerBridge, type WebGamePlayerRequest, type WebGamePlayerState } from "../shared/web-game-player.js";

interface BrowserPlayer {
  window: Window;
  ready: Promise<void>;
  url?: string;
}

/** Keeps browser players across workspace tab changes and project navigation. */
export class BrowserGamePlayers implements WebGamePlayerBridge {
  readonly #players = new Map<string, BrowserPlayer>();
  readonly #listeners = new Set<(state: WebGamePlayerState) => void>();
  #timer?: ReturnType<typeof setInterval>;

  isOpen(projectId: string): boolean {
    const player = this.#players.get(projectId);
    return !!player && !player.window.closed;
  }

  async state(projectId: string): Promise<WebGamePlayerState> {
    const player = this.#players.get(projectId);
    if (player?.window.closed) this.#forget(projectId, player);
    return { projectId, open: this.isOpen(projectId) };
  }

  async open(projectId: string, request: WebGamePlayerRequest): Promise<void> {
    void this.state(projectId);
    let player = this.#players.get(projectId);
    if (!player) {
      // Create synchronously in the click handler so browsers allow the popup.
      const popup = window.open("about:blank", `ohmygame-player-${projectId}`, `popup,width=${request.viewport.width},height=${request.viewport.height}`);
      if (!popup) throw new Error("Allow popups to play this game in a new window.");
      popup.opener = null;
      player = { window: popup, ready: Promise.resolve() };
      this.#players.set(projectId, player);
      this.#publish(projectId);
      this.#timer ??= setInterval(() => {
        for (const id of this.#players.keys()) void this.state(id);
      }, 500);
      const opening = player;
      player.ready = ensureProjectPreview(projectId).then(({ url }) => {
        if (opening.window.closed) throw new Error("The game window was closed.");
        opening.url = webGamePlayerUrl(url, request.path);
        opening.window.location.href = opening.url;
      }).catch((error) => {
        opening.window.close();
        this.#forget(projectId, opening);
        throw error;
      });
    }
    await player.ready;
    player.window.focus();
  }

  onState(listener: (state: WebGamePlayerState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async refresh(projectId: string, reload = false): Promise<void> {
    const player = this.#players.get(projectId);
    if (!player) return;
    await player.ready;
    const { url } = await ensureProjectPreview(projectId);
    if (player.window.closed || !player.url) return;
    // A cross-origin browser popup cannot expose its current route to the editor.
    const current = new URL(player.url);
    if (!reload && new URL(url).origin === current.origin) return;
    player.url = webGamePlayerUrl(url, `${current.pathname}${current.search}${current.hash}`);
    player.window.location.href = player.url;
  }

  #forget(projectId: string, player: BrowserPlayer): void {
    if (this.#players.get(projectId) !== player) return;
    this.#players.delete(projectId);
    this.#publish(projectId);
    if (!this.#players.size) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #publish(projectId: string): void {
    const state = { projectId, open: this.#players.has(projectId) };
    for (const listener of this.#listeners) listener(state);
  }
}

const browserPlayers = new BrowserGamePlayers();
interface PlayerState extends WebGamePlayerState {
  checking: boolean;
  pending: boolean;
  error?: string;
}

export function useWebGamePlayer(projectId: string | undefined, previewBaseUrl: string | undefined) {
  const desktop = typeof window === "undefined" ? undefined : window.ohMyGameDesktop?.webGamePlayer;
  const bridge = desktop ?? browserPlayers;
  const initial = (): PlayerState => ({ projectId: projectId ?? "", open: !desktop && !!projectId && browserPlayers.isOpen(projectId), checking: !!desktop && !!projectId, pending: false });
  const [state, setState] = useState<PlayerState>(initial);
  const busy = useRef<string | undefined>(undefined);
  const stateRevision = useRef(0);
  const shown = state.projectId === projectId ? state : initial();

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let receivedState = false;
    setState(initial());
    const unsubscribe = bridge.onState((next) => {
      if (next.projectId !== projectId || disposed) return;
      receivedState = true;
      stateRevision.current += 1;
      setState((current) => ({ ...current, ...next, checking: false }));
    });
    void bridge.state(projectId).then((next) => {
      if (!disposed && !receivedState) setState((current) => ({ ...current, ...next, checking: false }));
    }).catch((error) => {
      // Keep the preview suspended when the editor cannot determine who owns the game.
      if (!disposed && !receivedState) setState((current) => ({ ...current, error: message(error) }));
    });
    return () => { disposed = true; unsubscribe(); };
  }, [projectId, bridge]);

  useEffect(() => {
    if (!projectId || !shown.open || !previewBaseUrl) return;
    let disposed = false;
    void bridge.refresh(projectId).catch((error) => {
      if (!disposed) setState((current) => current.projectId === projectId ? { ...current, error: message(error) } : current);
    });
    return () => { disposed = true; };
  }, [projectId, previewBaseUrl, shown.open, bridge]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (!projectId || busy.current === projectId) return;
    busy.current = projectId;
    setState((current) => ({ ...(current.projectId === projectId ? current : initial()), pending: true, error: undefined }));
    try {
      await action();
      const revision = stateRevision.current;
      const next = await bridge.state(projectId);
      if (stateRevision.current === revision) {
        setState((current) => current.projectId === projectId ? { ...current, ...next, checking: false } : current);
      }
    } catch (error) {
      setState((current) => current.projectId === projectId ? { ...current, error: message(error) } : current);
    } finally {
      if (busy.current === projectId) busy.current = undefined;
      setState((current) => current.projectId === projectId ? { ...current, pending: false } : current);
    }
  }

  return {
    ...shown,
    suspended: shown.open || shown.pending || shown.checking,
    play: (request: WebGamePlayerRequest) => run(() => bridge.open(projectId!, request)),
    reload: () => run(() => bridge.refresh(projectId!, true)),
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
