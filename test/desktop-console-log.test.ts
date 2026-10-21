import { expect, it, vi } from "vitest";
import {
  recordConsole,
  rendererConsoleLines,
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
    "[error] first",
    "[error] second",
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
