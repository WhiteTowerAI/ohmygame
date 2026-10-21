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
