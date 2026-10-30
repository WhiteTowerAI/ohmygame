import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, History, InfoCircle, LoaderCircle, Pencil, Play, RotateCcw, Sparkles, X } from "./icons.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import type { PlayableDebugRecord } from "../shared/playable-debug.js";
import { playableNodeById } from "../shared/playable-graph.js";
import { t } from "./i18n.js";

const RECENT_LIMIT = 8;

/** Starts at a chosen Scene with a new game's values, leaving the saved game untouched. */
export interface PlaytestStart {
  nodeId: string;
}

export type PlaytestAction = "replay" | "forget-seen";
/** `open` only brings Playtest forward, and loads the story again if the window could not play it. */
export type PlaytestRequest = { action: "start"; start: PlaytestStart } | { action: PlaytestAction | "open" };

const requestKey = (projectId: string) => `ohmygame:playtest:request:${projectId}`;

/**
 * Sends an editor request to Playtest. If the window is not open yet, the
 * request waits in localStorage until it is taken.
 */
export function requestPlaytest(projectId: string, request: PlaytestRequest): void {
  window.localStorage.setItem(requestKey(projectId), JSON.stringify(request));
}

/** Takes a waiting request, so it runs once. */
export function takePlaytestRequest(projectId: string): PlaytestRequest | undefined {
  const key = requestKey(projectId);
  const raw = window.localStorage.getItem(key);
  if (raw === null) return undefined;
  window.localStorage.removeItem(key);
  try {
    const request = JSON.parse(raw) as Partial<PlaytestRequest> | null;
    if (request?.action === "replay" || request?.action === "forget-seen" || request?.action === "open") return { action: request.action };
    if (request?.action === "start" && typeof request.start?.nodeId === "string") {
      return { action: "start", start: { nodeId: request.start.nodeId } };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Calls `onRequest` whenever the editor sends this Playtest an action. */
export function usePlaytestRequests(projectId: string, onRequest: (request: PlaytestRequest) => void): void {
  const handler = useRef(onRequest);
  handler.current = onRequest;
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== requestKey(projectId) || event.newValue === null) return;
      const request = takePlaytestRequest(projectId);
      if (request) handler.current(request);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
}

/** Editor controls live outside the game, including when a Scene Workbench is open. */
export function PlaytestControls({ disabled = false, busy = false, label, title, onOpen, onAction }: {
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  title?: string;
  onOpen: () => void;
  onAction?: (action: PlaytestAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const unavailable = disabled || busy;

  useEffect(() => {
    if (unavailable) { setOpen(false); return; }
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    // Pointer events inside the Workbench's preview frame do not reach this document.
    const onBlur = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, unavailable]);

  const run = (action: PlaytestAction) => {
    setOpen(false);
    trigger.current?.focus();
    onAction?.(action);
  };

  return <div className="playable-playtest-controls" ref={root}>
    <button className="icon-button pane-header-action" type="button" data-tooltip={busy ? t("storyEditor.openingPlaytest") : title ?? t("storyEditor.playtestWindow")} aria-label={label ?? t("storyEditor.playtest")} disabled={unavailable} onClick={onOpen}>
      {busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
    </button>
    {onAction ? <button
      ref={trigger} className="icon-button pane-header-action playable-playtest-menu-trigger" type="button"
      title={t("playtest.actions")} aria-label={t("playtest.actions")} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      disabled={unavailable} onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}
    ><ChevronDown size={11} /></button> : null}
    {open && !unavailable ? <div
      ref={menu} className="playable-playtest-menu" id={menuId} role="menu" aria-label={t("playtest.actions")}
      onKeyDown={(event) => {
        if (event.key === "Tab") { setOpen(false); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      }}
    >
      <button type="button" role="menuitem" title={t("playtest.replayTitle")} onClick={() => run("replay")}><RotateCcw size={14} /><span>{t("playtest.replay")}</span></button>
      <button type="button" role="menuitem" title={t("playtest.forgetTitle")} onClick={() => run("forget-seen")}><History size={14} /><span>{t("playtest.forget")}</span></button>
    </div> : null}
  </div>;
}

const askKey = (projectId: string) => `ohmygame:playtest:ask:${projectId}`;

/** Hands a request from the Playtest window to the editor's chat, which may be in another window. */
export function requestAskAgent(projectId: string, text: string): void {
  window.localStorage.setItem(askKey(projectId), JSON.stringify({ text, id: Date.now() }));
}

/** How long a request waits for an editor that is still opening. */
const ASK_WAIT_MS = 60_000;

/**
 * Calls `onAsk` in the editor whenever its Playtest window hands over a
 * request, including one sent just before the editor opened, since Playtest
 * can bring the editor forward with the request.
 */
export function usePlaytestAskRequests(projectId: string | undefined, onAsk: (text: string) => void): void {
  const handler = useRef(onAsk);
  handler.current = onAsk;
  useEffect(() => {
    if (!projectId) return;
    const take = (value: string, waiting: boolean) => {
      window.localStorage.removeItem(askKey(projectId));
      try {
        const request = JSON.parse(value) as { text?: unknown; id?: unknown };
        if (waiting && !(typeof request.id === "number" && Date.now() - request.id < ASK_WAIT_MS)) return;
        if (typeof request.text === "string") handler.current(request.text);
      } catch {
        // Not a request this editor wrote.
      }
    };
    const waiting = window.localStorage.getItem(askKey(projectId));
    if (waiting !== null) take(waiting, true);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== askKey(projectId) || event.newValue === null) return;
      take(event.newValue, false);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
}

/**
 * What the Playtest window shows over the game: nothing while it works. When
 * something breaks, a short note offers to hand the problem to the AI, with
 * what the player was doing. Playtest controls stay in the editor.
 */
export function PlaytestOverlay({ graph, record, diagnostics, onAskAgent }: {
  graph: NodeGraph;
  record?: PlayableDebugRecord;
  diagnostics: readonly string[];
  onAskAgent?: (text: string) => void;
}) {
  const errors = [...(record?.errors ?? []).map((error) => error.message), ...diagnostics];
  const [dismissed, setDismissed] = useState(0);
  const [sent, setSent] = useState(false);
  const shown = errors.length > dismissed;
  useEffect(() => setSent(false), [errors.length]);

  return <>
    {shown ? <aside className="playable-playtest-problem" role="alert">
      <InfoCircle size={13} />
      <span>{sent ? t("playtest.addedToChat") : t("playtest.broke")}</span>
      {onAskAgent && !sent ? <button type="button" className="is-primary" onClick={() => { onAskAgent(askToFixPlaytest(graph, record, errors)); setSent(true); }}><Sparkles size={11} /><span>{t("playtest.askFix")}</span></button> : null}
      <button type="button" aria-label={t("notice.dismiss")} title={t("notice.dismiss")} onClick={() => setDismissed(errors.length)}><X size={11} /></button>
    </aside> : null}
  </>;
}

/** The chat request behind "Ask AI to fix": where the player was, what they did, and what failed. */
export function askToFixPlaytest(graph: NodeGraph, record: PlayableDebugRecord | undefined, errors: readonly string[]): string {
  const titleOf = (nodeId?: string) => (nodeId ? playableNodeById(graph, nodeId)?.title : undefined) ?? nodeId ?? "";
  const lines = ["Something broke while I was playtesting. Find the cause and fix it."];
  if (record) lines.push(`I was in ${titleOf(record.currentNode.id)}.`);
  const steps = record?.recentSignals.slice(-RECENT_LIMIT) ?? [];
  if (steps.length) {
    lines.push("", "What I did:");
    for (const step of steps) lines.push(`- ${titleOf(step.nodeId)}: "${step.signal}" → ${step.followed ? titleOf(step.targetNodeId) : "goes nowhere"}`);
  }
  lines.push("", "Errors:", ...errors.slice(-RECENT_LIMIT).map((error) => `- ${error}`));
  return lines.join("\n");
}

/**
 * Why Playtest cannot play the story, with the service's message when there
 * is one: `stopped` is a game that had started; every other kind never did.
 */
export interface PlaytestProblemState {
  kind: "no-scenes" | "missing-start" | "not-found" | "needs-upgrade" | "invalid" | "unavailable" | "stopped";
  detail?: string;
}

/**
 * What the Playtest window shows instead of the game when the story cannot
 * start or stops: what is wrong, and the way forward for that case. Without a way to
 * reach the editor, closing the window takes its place.
 */
export function PlaytestProblem({ problem, onOpenEditor, onRetry, onPlayFromStart, onAskAgent, onClose }: {
  problem: PlaytestProblemState;
  onOpenEditor?: () => void;
  onRetry: () => void;
  onPlayFromStart: () => void;
  /** Hands the problem to the AI; the page knows what the player was doing. */
  onAskAgent: () => void;
  onClose: () => void;
}) {
  const [sent, setSent] = useState(false);
  useEffect(() => setSent(false), [problem.kind, problem.detail]);
  const { title, body } = {
    "no-scenes": { title: t("playtest.noScenesTitle"), body: t("playtest.noScenesBody") },
    "missing-start": { title: t("playtest.missingStartTitle"), body: t("playtest.missingStartBody") },
    "not-found": { title: t("playtest.notFoundTitle"), body: t("playtest.notFoundBody") },
    "needs-upgrade": { title: t("playtest.needsUpgradeTitle"), body: t("playtest.needsUpgradeBody") },
    invalid: { title: t("playtest.invalidTitle"), body: t("playtest.invalidBody") },
    unavailable: { title: t("playtest.unavailableTitle"), body: t("playtest.unavailableBody") },
    stopped: { title: t("playtest.stoppedTitle"), body: t("playtest.stoppedBody") },
  }[problem.kind];

  const close = <button key="close" type="button" onClick={onClose}><X size={13} /><span>{t("playtest.closeWindow")}</span></button>;
  const editor = onOpenEditor
    ? <button key="editor" type="button" onClick={onOpenEditor}><Pencil size={13} /><span>{t("playtest.openEditor")}</span></button>
    : close;
  const retry = <button key="retry" type="button" onClick={onRetry}><RotateCcw size={13} /><span>{t("playtest.tryAgain")}</span></button>;
  const ask = sent
    ? <span key="ask" className="playtest-problem-sent">{t("playtest.addedToChat")}</span>
    : <button key="ask" type="button" onClick={() => { onAskAgent(); setSent(true); }}><Sparkles size={13} /><span>{t("playtest.askFix")}</span></button>;
  const actions = {
    "no-scenes": [editor],
    "missing-start": [<button key="start" type="button" onClick={onPlayFromStart}><Play size={13} /><span>{t("playtest.playFromStart")}</span></button>, editor],
    "not-found": [close],
    "needs-upgrade": [editor, retry],
    invalid: [ask, retry, editor],
    unavailable: [retry, editor],
    stopped: [ask, <button key="again" type="button" onClick={onRetry}><RotateCcw size={13} /><span>{t("playtest.playAgain")}</span></button>, editor],
  }[problem.kind];

  return <main className="playable-player-page">
    <section className="playtest-problem" role="alert" aria-labelledby="playtest-problem-title">
      <InfoCircle size={20} />
      <h1 id="playtest-problem-title">{title}</h1>
      <p>{body}</p>
      {problem.detail ? <p className="playtest-problem-detail">{problem.detail}</p> : null}
      <div className="playtest-problem-actions">{actions}</div>
    </section>
  </main>;
}

/** The chat request behind "Ask AI to fix" when the story could not start at all. */
export function askToFixPlaytestStart(error: string): string {
  return ["Playtest could not start the story. Find the cause and fix it.", "", "Error:", `- ${error}`].join("\n");
}
