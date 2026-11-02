import { useEffect, useState } from "react";
import type { GameRecordingBridge, GameRecordingState } from "../shared/game-recording.js";
import { t } from "./i18n.js";
import { Circle, LoaderCircle, Square } from "./icons.js";
import { Button, IconButton, useToast } from "./ui/index.js";

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

/** Records the running game; absent where a game can't be recorded. */
export function GameRecordButton({ projectId, gameRunning }: { projectId: string; gameRunning: boolean }) {
  const bridge = recordingBridge();
  const toast = useToast();
  const [state, setState] = useState<GameRecordingState>({ projectId, status: "idle" });
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!bridge) return;
    let current = true;
    setState({ projectId, status: "idle" });
    void bridge.state(projectId).then((next) => { if (current) setState(next); }, () => undefined);
    const unsubscribe = bridge.onState((next) => { if (next.projectId === projectId) setState(next); });
    return () => { current = false; unsubscribe(); };
  }, [bridge, projectId]);
  useEffect(() => {
    if (state.status !== "recording") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.status]);
  if (!bridge) return null;
  if (state.status === "saving") {
    return <Button size="sm" variant="ghost" className="preview-record-button" disabled icon={<LoaderCircle className="spin" size={14} />}>{t("gameRecording.saving")}</Button>;
  }
  if (state.status === "recording") {
    const time = clock((now - (state.startedAt ?? now)) / 1000);
    return <Button size="sm" variant="ghost" className="preview-record-button is-recording" aria-label={t("gameRecording.recordingStatus", { time })} data-tooltip={t("gameRecording.stop")}
      icon={<Square size={12} fill="currentColor" />}
      onClick={() => void bridge.stop(projectId).catch((cause: unknown) => toast({ title: t("gameRecording.failed"), description: desktopError(cause), tone: "danger" }))}>{time}</Button>;
  }
  return <IconButton size="sm" className="preview-record-button" label={t("gameRecording.startHint", { shortcut: shortcut() })} disabled={!gameRunning || starting}
    onClick={() => {
      setStarting(true);
      void bridge.start(projectId)
        .catch((cause: unknown) => toast({ title: t("gameRecording.failed"), description: desktopError(cause), tone: "danger" }))
        .finally(() => setStarting(false));
    }}>{starting ? <LoaderCircle className="spin" size={14} /> : <Circle size={14} />}</IconButton>;
}

/** Calls back each time a recording reaches the Library. */
export function onGameRecordingSaved(listener: () => void): () => void {
  return recordingBridge()?.onSaved(listener) ?? (() => {});
}

/** Says how a recording came out, from whichever page the person has moved on to. */
export function GameRecordingNotices() {
  const toast = useToast();
  useEffect(() => recordingBridge()?.onState((state) => {
    if (state.saved) {
      toast({
        title: t("gameRecording.saved"),
        description: state.saved.name,
        action: { label: t("gameRecording.open"), onClick: () => { window.location.hash = "#/library"; } },
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
