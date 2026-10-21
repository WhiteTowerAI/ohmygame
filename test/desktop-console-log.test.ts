import { expect, it, vi } from "vitest";
import { recordConsole } from "../src/desktop/console-log.js";

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
