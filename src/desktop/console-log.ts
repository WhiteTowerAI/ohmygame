import { format } from "node:util";
import type { LogWriter } from "./log-file.js";

const LEVELS = ["debug", "log", "info", "warn", "error"] as const;

/** Copies console output to a log, as a packaged app has no console to show it. */
export function recordConsole(
  log: Pick<LogWriter, "line">,
  target: Pick<Console, (typeof LEVELS)[number]> = console,
): void {
  for (const level of LEVELS) {
    const write = target[level].bind(target);
    target[level] = (...values: unknown[]) => {
      for (const line of format(...values).split("\n")) {
        log.line(`[${level}] ${line}`);
      }
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
  const message = details.message.slice(0, MAX_RENDERER_MESSAGE_LENGTH);
  return `${message}${source}`
    .split("\n")
    .map((line) => `[renderer ${details.level}] ${line}`);
}
