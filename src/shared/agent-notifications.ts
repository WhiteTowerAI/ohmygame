import type { AgentNoticeKind } from "./agent-notices.js";

/** The conversation a system notification opens, or the one the main window shows. */
export interface AgentNotificationTarget {
  projectId: string;
  conversationId: string;
}

/**
 * Notification settings and wording. The renderer owns both, since the
 * settings live with the other renderer preferences and the wording follows
 * the UI language; the main process keeps the last copy it was sent so
 * notifications still work while the window is closed.
 */
export interface AgentNotificationPreferences {
  enabled: boolean;
  sound: boolean;
  text: Record<AgentNoticeKind, string> & { fallbackTitle: string };
}

export const DEFAULT_AGENT_NOTIFICATION_PREFERENCES: AgentNotificationPreferences = {
  enabled: true,
  sound: true,
  text: {
    fallbackTitle: "OhMyGame",
    approval: "Waiting for your approval",
    question: "Has a question for you",
    plan: "A plan is ready for your review",
    completed: "Finished",
    failed: "Stopped with an error",
  },
};

const MAX_TEXT_LENGTH = 200;

/** Checks preferences sent over IPC. */
export function parseAgentNotificationPreferences(value: unknown): AgentNotificationPreferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentNotificationPreferences>;
  if (typeof candidate.enabled !== "boolean" || typeof candidate.sound !== "boolean") return undefined;
  const text = candidate.text as Record<string, unknown> | undefined;
  if (!text || typeof text !== "object") return undefined;
  const parsed = {} as AgentNotificationPreferences["text"];
  for (const key of Object.keys(DEFAULT_AGENT_NOTIFICATION_PREFERENCES.text) as (keyof AgentNotificationPreferences["text"])[]) {
    const entry = text[key];
    if (typeof entry !== "string" || !entry.trim() || entry.length > MAX_TEXT_LENGTH) return undefined;
    parsed[key] = entry;
  }
  return { enabled: candidate.enabled, sound: candidate.sound, text: parsed };
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
