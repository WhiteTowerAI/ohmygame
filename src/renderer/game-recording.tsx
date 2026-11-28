import { useEffect, useState } from "react";
import type { GameRecordingBridge, GameRecordingState } from "../shared/game-recording.js";
import { t } from "./i18n.js";
import { Circle, Spinner, Stop } from "./icons.js";
import { Button, IconButton, useToast, type MenuItem } from "./ui/index.js";

function recordingBridge(): GameRecordingBridge | undefined {
  return globalThis.window?.ohMyGameDesktop?.webGamePlayer?.recording;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function shortcut(): string {
  return navigator.platform.toLowerCase().includes("mac") ? "\u2318\u21E7R" : "Ctrl+Shift+R";
}

/** The project's game recording: whether the game can be recorded here, its state, and how to start or stop it. */
export interface GameRecording {
  available: boolean;
  state: GameRecordingState;
  starting: boolean;
  start: () => void;
  stop: () => void;
}

/** Follows the project's game recording; unavailable where a game can't be recorded. */
export function useGameRecording(projectId: string | undefined): GameRecording {
  const bridge = recordingBridge();
  const toast = useToast();
  const [state, setState] = useState<GameRecordingState>({ projectId: projectId ?? "", status: "idle" });
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!bridge || !projectId) return;
    let current = true;
    setState({ projectId, status: "idle" });
    void bridge.state(projectId).then((next) => { if (current) setState(next); }, () => undefined);
    const unsubscribe = bridge.onState((next) => { if (next.projectId === projectId) setState(next); });
    return () => { current = false; unsubscribe(); };
  }, [bridge, projectId]);
  const failed = (cause: unknown) => toast({ title: t("gameRecording.failed"), description: desktopError(cause), tone: "danger" });
  return {
    available: !!bridge && !!projectId,
    state,
    starting,
    start: () => {
      if (!bridge || !projectId) return;
      setStarting(true);
      void bridge.start(projectId).catch(failed).finally(() => setStarting(false));
    },
    stop: () => {
      if (bridge && projectId) void bridge.stop(projectId).catch(failed);
    },
  };
}

/**
 * The game's menu item that starts a recording: absent where the game can't
 * be recorded, until it runs, and while a recording is on its way.
 */
export function recordMenuItem(recording: GameRecording, gameRunning: boolean): MenuItem | undefined {
  if (!recording.available || !gameRunning || recording.starting || recording.state.status !== "idle") return undefined;
  return { label: t("gameRecording.start"), description: t("gameRecording.shortcutHint", { shortcut: shortcut() }), icon: <Circle size="sm" />, onSelect: recording.start };
}

/** A recording on its way: starting, then its time (which stops it), then saving. Absent otherwise. */
export function GameRecordStatus({ recording }: { recording: GameRecording }) {
  const { available, state, starting, stop } = recording;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.status !== "recording") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.status]);
  if (!available) return null;
  if (state.status === "saving") {
    return <Button size="sm" variant="ghost" className="preview-record-button" disabled icon={<Spinner size="sm" />}>{t("gameRecording.saving")}</Button>;
  }
  if (state.status === "recording") {
    const time = clock((now - (state.startedAt ?? now)) / 1000);
    return <Button size="sm" variant="ghost" className="preview-record-button is-recording" aria-label={t("gameRecording.recordingStatus", { time })} data-tooltip={t("gameRecording.stop")}
      icon={<Stop size="xs" fill="currentColor" />} onClick={stop}>{time}</Button>;
  }
  return starting ? <IconButton size="sm" className="preview-record-button" label={t("gameRecording.start")} disabled><Spinner size="sm" /></IconButton> : null;
}

/** Says how a recording came out, from whichever page the person has moved on to. */
export function GameRecordingNotices() {
  const toast = useToast();
  useEffect(() => recordingBridge()?.onState((state) => {
    if (state.saved) {
      toast({
        title: t("gameRecording.saved"),
        description: state.saved.name,
      });
    } else if (state.error) {
      toast({ title: t("gameRecording.failed"), description: state.error, tone: "danger" });
    }
  }), [toast]);
  return null;
}

/** Electron wraps what the main process throws in text about the IPC call. */
function desktopError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
