import { useEffect, useRef } from "react";
import type { AgentNotificationTarget } from "../shared/agent-notifications.js";
import { t } from "./i18n.js";

const NOTIFICATIONS_STORAGE_KEY = "ohmygame:notifications";

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
}

export function readNotificationSettings(): NotificationSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) ?? "{}") as Partial<NotificationSettings>;
    return { enabled: stored.enabled !== false, sound: stored.sound !== false };
  } catch {
    return { enabled: true, sound: true };
  }
}

export function setNotificationSettings(settings: NotificationSettings): void {
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(settings));
  sendNotificationPreferences(settings);
}

/**
 * Tells the desktop app the settings and the wording in the UI language. The
 * app keeps them, so notifications still follow them while the window is closed.
 */
export function sendNotificationPreferences(settings = readNotificationSettings()): void {
  void window.ohMyGameDesktop?.notifications?.setPreferences({
    ...settings,
    text: {
      fallbackTitle: "OhMyGame",
      approval: t("notifications.approval"),
      question: t("notifications.question"),
      plan: t("notifications.plan"),
      completed: t("notifications.completed"),
      failed: t("notifications.failed"),
    },
  }).catch(() => undefined);
}

/** Tells the desktop app which conversation is on screen, so its notifications are not shown while the window is in front. */
export function useNotificationView(projectId: string | undefined, conversationId: string | undefined): void {
  useEffect(() => {
    const notifications = window.ohMyGameDesktop?.notifications;
    if (!notifications || !projectId || !conversationId) return undefined;
    void notifications.setView({ projectId, conversationId }).catch(() => undefined);
    return () => { void notifications.setView(null).catch(() => undefined); };
  }, [projectId, conversationId]);
}

/** Opens the conversation of a clicked notification, including one clicked while the window was closed. */
export function useNotificationTargets(open: (target: AgentNotificationTarget) => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const notifications = window.ohMyGameDesktop?.notifications;
    if (!notifications) return undefined;
    const take = () => {
      void notifications.takeTarget().then((target) => { if (target) latest.current(target); }, () => undefined);
    };
    take();
    return notifications.onTarget(take);
  }, []);
}
