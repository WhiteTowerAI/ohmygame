import { format } from "node:util";
import type { DesktopRuntimeState } from "../shared/desktop-runtime.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import type { LogWriter } from "./log-file.js";
import { createLogRedactor } from "../shared/log-redaction.js";

const LEVELS = ["debug", "log", "info", "warn", "error"] as const;
const redact = createLogRedactor();

/** Copies console output to a log, as a packaged app has no console to show it. */
export function recordConsole(
  log: Pick<LogWriter, "line">,
  target: Pick<Console, (typeof LEVELS)[number]> = console,
): void {
  for (const level of LEVELS) {
    const write = target[level].bind(target);
    target[level] = (...values: unknown[]) => {
      log.line(`[${level}] ${format(...values)}`);
      write(...values);
    };
  }
}

interface RendererConsoleMessage {
  level: string;
  message: string;
  sourceId?: string;
  lineNumber?: number;
}

const MAX_RENDERER_MESSAGE_LENGTH = 4_000;

/** Renderer warnings and errors, which otherwise stay in the window's developer tools. */
export function rendererConsoleLines(
  details: RendererConsoleMessage,
): string[] {
  if (details.level !== "warning" && details.level !== "error") return [];
  const file = details.sourceId?.split(/[?#]/, 1)[0]?.split("/").pop();
  const source = file ? ` (${file}:${details.lineNumber ?? 0})` : "";
  const message = redact(details.message, {
    maxLength: MAX_RENDERER_MESSAGE_LENGTH,
  });
  return `${message}${source}`
    .split("\n")
    .map((line) => `[renderer ${details.level}] ${line}`);
}

/** Errors that would end the process; Electron reports them only to stderr. */
export function recordUncaughtErrors(
  log: Pick<LogWriter, "line"> & { flushSync?(): void },
  target: Pick<NodeJS.Process, "on"> = process,
): void {
  target.on("uncaughtExceptionMonitor", (error, origin) => {
    const text =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    log.line(`[fatal] ${origin}: ${text}`);
    // The process may end before a background write runs.
    log.flushSync?.();
  });
}

/** One line per update failure, with what the Settings page shows as technical details. */
export function updateFailureLine(
  state: DesktopUpdateState,
): string | undefined {
  const status = state.status;
  if (status.type !== "error") return undefined;
  return `[update] ${status.phase} failed (${status.code}): ${status.title}: ${status.detail}`;
}

/** Service status changes, so a log shows when the daemon restarted or stopped. */
export function runtimeStateLine(state: DesktopRuntimeState): string {
  return `[service] ${state.status} (generation ${state.generation}${state.recovered ? ", recovered" : ""})${state.error ? `: ${state.error}` : ""}`;
}
