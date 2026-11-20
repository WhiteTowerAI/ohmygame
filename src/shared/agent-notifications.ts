import type { AgentNoticeKind } from "./agent-notices.js";

/** The conversation a system notification opens, or the one the main window shows. */
export interface AgentNotificationTarget {
  projectId: string;
  conversationId: string;
}

/** A daemon cursor already rendered at the live end of the conversation. */
export interface AgentResultRead extends AgentNotificationTarget {
  epoch: string;
  eventId: number;
}

/**
 * Whether the system lets the app show notifications. `quiet` notifications
 * reach Notification Center without a banner. `unknown` is a system whose
 * permission the app cannot read, such as Windows; `unavailable` is a macOS
 * development build, which shares Electron's permission with every other app.
 */
export type AgentNotificationPermission = "allowed" | "denied" | "not-determined" | "quiet" | "unknown" | "unavailable";

/**
 * Notification settings and wording. The renderer owns both, since the
 * setting lives with the other renderer preferences and the wording follows
 * the UI language; the main process keeps the last copy it was sent so
 * notifications still work while the window is closed. Sound follows the
 * system's notification settings.
 */
export interface AgentNotificationPreferences {
  enabled: boolean;
  /** `waiting` and `unread` describe the Dock badge, taskbar overlay or tray badge. */
  text: Record<AgentNoticeKind, string> & { fallbackTitle: string; waiting: string; unread: string };
}

export const DEFAULT_AGENT_NOTIFICATION_PREFERENCES: AgentNotificationPreferences = {
  enabled: true,
  text: {
    fallbackTitle: "OhMyGame",
    approval: "Waiting for your approval",
    question: "Has a question for you",
    plan: "A plan is ready for your review",
    completed: "Finished",
    failed: "Stopped with an error",
    waiting: "Waiting for you",
    unread: "Unread results",
  },
};

const MAX_TEXT_LENGTH = 200;

/** Checks preferences sent over IPC. */
export function parseAgentNotificationPreferences(value: unknown): AgentNotificationPreferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentNotificationPreferences>;
  if (typeof candidate.enabled !== "boolean") return undefined;
  const text = candidate.text as Record<string, unknown> | undefined;
  if (!text || typeof text !== "object") return undefined;
  const parsed = {} as AgentNotificationPreferences["text"];
  for (const key of Object.keys(DEFAULT_AGENT_NOTIFICATION_PREFERENCES.text) as (keyof AgentNotificationPreferences["text"])[]) {
    const entry = text[key];
    if (typeof entry !== "string" || !entry.trim() || entry.length > MAX_TEXT_LENGTH) return undefined;
    parsed[key] = entry;
  }
  return { enabled: candidate.enabled, text: parsed };
}

/** Checks a target sent over IPC; `null` means no conversation. */
export function parseAgentNotificationTarget(value: unknown): AgentNotificationTarget | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { projectId, conversationId } = value as Partial<AgentNotificationTarget>;
  if (typeof projectId !== "string" || !projectId || projectId.length > 200) return undefined;
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 200) return undefined;
  return { projectId, conversationId };
}

/** Checks a rendered cursor sent over IPC. */
export function parseAgentResultRead(value: unknown): AgentResultRead | undefined {
  const target = parseAgentNotificationTarget(value);
  if (!target) return undefined;
  const { epoch, eventId } = value as Partial<AgentResultRead>;
  if (typeof epoch !== "string" || !epoch || epoch.length > 200) return undefined;
  if (typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId <= 0) return undefined;
  return { ...target, epoch, eventId };
}
