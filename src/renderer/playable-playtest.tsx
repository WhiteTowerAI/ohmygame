import { useEffect, useRef, useState } from "react";
import { InfoCircle, RotateCcw, Sparkles, X } from "./icons.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import type { PlayableDebugRecord } from "../shared/playable-debug.js";
import { playableNodeById } from "../shared/playable-graph.js";
import type { PlaytestStart } from "./playable-node-workbench.js";

export type { PlaytestStart };

const RECENT_LIMIT = 8;

const startKey = (projectId: string) => `ohmygame:playtest:start:${projectId}`;

/**
 * Asks the Playtest window to start at a Scene ("Play from here"). The window
 * may not be open yet, so the request waits in localStorage until it is taken.
 */
export function requestPlaytestStart(projectId: string, start: PlaytestStart): void {
  window.localStorage.setItem(startKey(projectId), JSON.stringify(start));
}

/** Takes a waiting start request, so it runs once. */
export function takePlaytestStart(projectId: string): PlaytestStart | undefined {
  const key = startKey(projectId);
  const raw = window.localStorage.getItem(key);
  if (raw === null) return undefined;
  window.localStorage.removeItem(key);
  try {
    const start = JSON.parse(raw) as Partial<PlaytestStart>;
    return typeof start.nodeId === "string" ? { nodeId: start.nodeId } : undefined;
  } catch {
    return undefined;
  }
}

/** Calls `onStart` whenever another window asks this Playtest to start somewhere. */
export function usePlaytestStartRequests(projectId: string, onStart: (start: PlaytestStart) => void): void {
  const handler = useRef(onStart);
  handler.current = onStart;
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== startKey(projectId) || event.newValue === null) return;
      const start = takePlaytestStart(projectId);
      if (start) handler.current(start);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
}

const askKey = (projectId: string) => `ohmygame:playtest:ask:${projectId}`;

/** Hands a request from the Playtest window to the editor's chat, which may be in another window. */
export function requestAskAgent(projectId: string, text: string): void {
  window.localStorage.setItem(askKey(projectId), JSON.stringify({ text, id: Date.now() }));
}

/** Calls `onAsk` in the editor whenever its Playtest window hands over a request. */
export function usePlaytestAskRequests(projectId: string | undefined, onAsk: (text: string) => void): void {
  const handler = useRef(onAsk);
  handler.current = onAsk;
  useEffect(() => {
    if (!projectId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== askKey(projectId) || event.newValue === null) return;
      window.localStorage.removeItem(askKey(projectId));
      try {
        const request = JSON.parse(event.newValue) as { text?: unknown };
        if (typeof request.text === "string") handler.current(request.text);
      } catch {
        // Not a request this editor wrote.
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
}

/**
 * What the Playtest window shows over the game: nothing while it works. When
 * something breaks, a short note offers to hand the problem to the AI, with
 * what the player was doing. Replay appears on hover in the corner.
 */
export function PlaytestOverlay({ graph, record, diagnostics, onRestart, onAskAgent }: {
  graph: NodeGraph;
  record?: PlayableDebugRecord;
  diagnostics: readonly string[];
  onRestart: () => void;
  onAskAgent?: (text: string) => void;
}) {
  const errors = [...(record?.errors ?? []).map((error) => error.message), ...diagnostics];
  const [dismissed, setDismissed] = useState(0);
  const [sent, setSent] = useState(false);
  const shown = errors.length > dismissed;
  useEffect(() => setSent(false), [errors.length]);

  return <>
    <button type="button" className="playable-playtest-replay" title="Replay from the start with a new game" aria-label="Replay" onClick={onRestart}><RotateCcw size={13} /></button>
    {shown ? <aside className="playable-playtest-problem" role="alert">
      <InfoCircle size={13} />
      <span>{sent ? "Added to the chat in the editor" : "Something broke"}</span>
      {onAskAgent && !sent ? <button type="button" className="is-primary" onClick={() => { onAskAgent(askToFixPlaytest(graph, record, errors)); setSent(true); }}><Sparkles size={11} /><span>Ask AI to fix</span></button> : null}
      <button type="button" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(errors.length)}><X size={11} /></button>
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
