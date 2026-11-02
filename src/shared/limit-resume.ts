import type { AgentUsageLimit } from "./contracts.js";

/** Sent once the limit resets; text sent to the agent stays in English. */
export const LIMIT_RESUME_PROMPT = "Continue where you left off.";

/** Margin after the reported reset, so the first request is not refused again. */
export const LIMIT_RESUME_MARGIN_MS = 30_000;

/**
 * When to continue (ms): the margin after every exhausted window the failure
 * fell inside has reset, or undefined when none reports a future reset. A
 * window that opened after the failure was exhausted by other work, and one
 * without a length can't be placed, so neither restarts an old conversation.
 */
export function limitResumeAt(limits: readonly AgentUsageLimit[] | undefined, failedAt: number, now = Date.now()): number | undefined {
  const resets = (limits ?? [])
    .filter((limit) => limit.usedPercent >= 100 && limit.resetsAt !== undefined && limit.windowMinutes !== undefined)
    .filter((limit) => limit.resetsAt! * 1000 > now && (limit.resetsAt! - limit.windowMinutes! * 60) * 1000 <= failedAt)
    .map((limit) => limit.resetsAt! * 1000);
  return resets.length ? Math.max(...resets) + LIMIT_RESUME_MARGIN_MS : undefined;
}
