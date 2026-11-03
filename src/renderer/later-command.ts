import type { ScheduledMessage } from "../shared/contracts.js";
import { LIMIT_RESUME_PROMPT } from "../shared/limit-resume.js";

const COMMAND = /^\/later(?:\s+(\S+)(?:\s+([\s\S]*))?)?\s*$/i;
const DURATION = /^(\d+(?:\.\d+)?)([mhd]?)$/i;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS };
const LONGEST_MS = 365 * UNIT_MS.d;

/** A scheduled time as the composer shows it. */
export function scheduleTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function isLaterCommand(value: string): boolean {
  return /^\s*\/later(\s|$)/i.test(value);
}

/** Reads `/later <time> [message]`, or undefined when its time can't be read. */
export function parseLaterCommand(value: string, now = Date.now()): { at: number; prompt: string } | undefined {
  const [, time, prompt] = value.trim().match(COMMAND) ?? [];
  const at = time ? resolveTime(time, now) : undefined;
  return at === undefined ? undefined : { at, prompt: prompt?.trim() || LIMIT_RESUME_PROMPT };
}

/** The command that schedules the same message again, for the person to change. */
export function laterCommand(message: ScheduledMessage, now = Date.now()): string {
  return `/later ${Math.max(1, Math.ceil((message.at - now) / MINUTE_MS))}m ${message.prompt}`;
}

/** A plain number is hours; a clock time is its next local occurrence. */
function resolveTime(time: string, now: number): number | undefined {
  const clock = time.match(CLOCK);
  if (clock) {
    const today = new Date(now);
    const on = (day: number) => new Date(today.getFullYear(), today.getMonth(), day, Number(clock[1]), Number(clock[2])).getTime();
    const next = on(today.getDate());
    return next > now ? next : on(today.getDate() + 1);
  }
  const duration = time.match(DURATION);
  if (!duration) return undefined;
  const delay = Number(duration[1]) * UNIT_MS[duration[2].toLowerCase() || "h"];
  return delay > 0 && delay <= LONGEST_MS ? now + Math.round(delay) : undefined;
}
