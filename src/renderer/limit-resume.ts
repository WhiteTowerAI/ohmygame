import type { AgentUsageLimit } from "../shared/contracts.js";

/** Sent once the limit resets; text sent to the agent stays in English. */
export const LIMIT_RESUME_PROMPT = "Continue where you left off.";

/** Margin after the reported reset, so the first request is not refused again. */
export const LIMIT_RESUME_MARGIN_MS = 30_000;

/** When every exhausted window has reset (ms), or undefined when no exhausted window reports a future reset. */
export function limitResumeAt(limits: readonly AgentUsageLimit[] | undefined, now = Date.now()): number | undefined {
  const resets = (limits ?? [])
    .filter((limit) => limit.usedPercent >= 100 && limit.resetsAt !== undefined && limit.resetsAt * 1000 > now)
    .map((limit) => limit.resetsAt! * 1000);
  return resets.length ? Math.max(...resets) + LIMIT_RESUME_MARGIN_MS : undefined;
}
