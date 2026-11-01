import { useEffect, useRef } from "react";
import { streamProjectActivity } from "./api.js";
import { GENERAL_PREFERENCES_EVENT, readGeneralPreferences } from "./general-preferences.js";
import { t } from "./i18n.js";
import { parseAppRoute } from "./routes.js";

/**
 * Settings → General, while the app is open: no system sleep while an agent
 * works, and a notification and a sound when one finishes out of sight: with
 * the window in the background, or on another page or project. An agent
 * waiting on an approval or a question is still
 * running, so it alerts when the turn ends, not while it waits.
 */
export function useRunAlerts(onOpenProject: (projectId: string) => void): void {
  const open = useRef(onOpenProject);
  open.current = onOpenProject;
  useEffect(() => {
    const controller = new AbortController();
    let running: ReadonlySet<string> | undefined;
    // Unknown at first, so the first snapshot tells the desktop app either way.
    let awake: boolean | undefined;
    const keepAwake = () => {
      const wanted = Boolean(running?.size) && readGeneralPreferences().keepAwake;
      if (wanted === awake) return;
      awake = wanted;
      void window.ohMyGameDesktop?.setKeepAwake?.(wanted).catch(() => undefined);
    };
    void streamProjectActivity(controller.signal, ({ activity, names }) => {
      const current = new Set(activity.map(({ projectId }) => projectId));
      for (const projectId of running ?? []) {
        if (!current.has(projectId)) alertFinished(projectId, names.find((project) => project.id === projectId)?.name, (id) => open.current(id));
      }
      running = current;
      keepAwake();
    });
    window.addEventListener(GENERAL_PREFERENCES_EVENT, keepAwake);
    return () => {
      controller.abort();
      window.removeEventListener(GENERAL_PREFERENCES_EVENT, keepAwake);
      running = undefined;
      keepAwake();
    };
  }, []);
}

function alertFinished(projectId: string, name: string | undefined, onOpen: (projectId: string) => void): void {
  if (document.hasFocus() && watching(projectId)) return;
  const preferences = readGeneralPreferences();
  if (preferences.runSound) playChime();
  if (!preferences.runNotifications || typeof Notification === "undefined") return;
  const show = () => {
    const notification = new Notification(name ?? "OhMyGame", { body: t("runAlerts.finished"), tag: `run:${projectId}` });
    notification.onclick = () => {
      void window.ohMyGameDesktop?.focusWindow?.().catch(() => undefined);
      window.focus();
      onOpen(projectId);
    };
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission === "default") void Notification.requestPermission().then((permission) => { if (permission === "granted") show(); });
}

/** Whether the window shows that project, where its chat says it finished. */
function watching(projectId: string): boolean {
  const route = parseAppRoute(window.location.hash);
  return route.page === "project" && route.projectId === projectId;
}

/** Two soft rising notes. */
function playChime(): void {
  const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const start = context.currentTime;
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * 0.12;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.32);
    });
    window.setTimeout(() => void context.close().catch(() => undefined), 800);
  } catch {
    // No audio device: the notification still shows.
  }
}
