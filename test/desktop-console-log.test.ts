import { expect, it, vi } from "vitest";
import {
  recordConsole,
  recordUncaughtErrors,
  rendererConsoleLines,
  runtimeStateLine,
  updateFailureLine,
} from "../src/desktop/console-log.js";

it("copies each console line to the log and still writes to the console", () => {
  const lines: string[] = [];
  const target = {
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const { warn, error } = target;
  recordConsole({ line: (text) => lines.push(text) }, target);

  target.warn("Could not configure session proxy", { code: "EPERM" });
  target.error("first\nsecond");

  expect(lines).toEqual([
    "[warn] Could not configure session proxy { code: 'EPERM' }",
    "[error] first\nsecond",
  ]);
  expect(warn).toHaveBeenCalledWith("Could not configure session proxy", {
    code: "EPERM",
  });
  expect(error).toHaveBeenCalledWith("first\nsecond");
});

it("records renderer warnings and errors with their source file", () => {
  expect(
    rendererConsoleLines({
      level: "error",
      message: "Uncaught TypeError: x is undefined\n    at render",
      sourceId:
        "file:///Applications/OhMyGame.app/renderer/assets/index-abc.js?v=1",
      lineNumber: 42,
    }),
  ).toEqual([
    "[renderer error] Uncaught TypeError: x is undefined",
    "[renderer error]     at render (index-abc.js:42)",
  ]);
  expect(
    rendererConsoleLines({ level: "warning", message: "Slow frame" }),
  ).toEqual(["[renderer warning] Slow frame"]);
  expect(rendererConsoleLines({ level: "info", message: "Loaded" })).toEqual(
    [],
  );
});

it("records uncaught errors with their stack", () => {
  const lines: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  recordUncaughtErrors(
    { line: (text) => lines.push(text) },
    {
      on: ((name: string, listener: (...args: unknown[]) => void) =>
        listeners.set(name, listener)) as never,
    },
  );
  const error = new Error("Cannot read properties of undefined");
  error.stack =
    "Error: Cannot read properties of undefined\n    at openMainWindow (main.js:1:1)";

  listeners.get("uncaughtExceptionMonitor")!(error, "uncaughtException");

  expect(lines).toEqual([
    "[fatal] uncaughtException: Error: Cannot read properties of undefined\n    at openMainWindow (main.js:1:1)",
  ]);
});

it("describes update failures and service status changes", () => {
  expect(
    updateFailureLine({
      currentVersion: "1.0.0",
      status: { type: "up-to-date" },
    } as never),
  ).toBeUndefined();
  expect(
    updateFailureLine({
      currentVersion: "1.0.0",
      status: {
        type: "error",
        phase: "download",
        code: "network",
        title: "The update download was interrupted",
        message: "",
        detail: "Error: read ECONNRESET",
        retry: "download",
        dataSafe: true,
      },
    }),
  ).toBe(
    "[update] download failed (network): The update download was interrupted: Error: read ECONNRESET",
  );
  expect(
    runtimeStateLine({
      status: "recovering",
      generation: 2,
      recovered: false,
      error: "The background service exited (1)",
    }),
  ).toBe(
    "[service] recovering (generation 2): The background service exited (1)",
  );
  expect(
    runtimeStateLine({ status: "ready", generation: 2, recovered: true }),
  ).toBe("[service] ready (generation 2, recovered)");
});
