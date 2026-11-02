import { describe, expect, it } from "vitest";
import { isLaterCommand, laterCommand, parseLaterCommand } from "../src/renderer/later-command.js";

const now = new Date(2026, 10, 3, 14, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("later command", () => {
  it("only takes the command itself", () => {
    expect(isLaterCommand("/later")).toBe(true);
    expect(isLaterCommand("  /LATER 2h go")).toBe(true);
    expect(isLaterCommand("/laterally")).toBe(false);
    expect(isLaterCommand("do this /later")).toBe(false);
  });

  it.each([
    ["2", 2 * HOUR],
    ["1.5", 1.5 * HOUR],
    ["30m", 30 * MINUTE],
    ["2H", 2 * HOUR],
    ["1d", 24 * HOUR],
  ])("reads %s as a delay, with a plain number in hours", (time, delay) => {
    expect(parseLaterCommand(`/later ${time} Go`, now)).toEqual({ at: now + delay, prompt: "Go" });
  });

  it("reads a clock time as its next local occurrence", () => {
    expect(parseLaterCommand("/later 15:30 Go", now)?.at).toBe(new Date(2026, 10, 3, 15, 30).getTime());
    expect(parseLaterCommand("/later 2:30 Go", now)?.at).toBe(new Date(2026, 10, 4, 2, 30).getTime());
    expect(parseLaterCommand("/later 14:00 Go", now)?.at).toBe(new Date(2026, 10, 4, 14, 0).getTime());
  });

  it("keeps the clock time for tomorrow when that time doesn't exist today", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const springForward = new Date(2026, 2, 8, 4, 0).getTime();
      expect(new Date(parseLaterCommand("/later 02:30 Go", springForward)!.at).toString()).toContain("Mar 09 2026 02:30");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("continues when there is no message, and keeps every line of one", () => {
    expect(parseLaterCommand("/later 2h", now)?.prompt).toBe("Continue where you left off.");
    expect(parseLaterCommand("/later 2h  ", now)?.prompt).toBe("Continue where you left off.");
    expect(parseLaterCommand("/later 2h First\nSecond", now)?.prompt).toBe("First\nSecond");
  });

  it.each(["/later", "/later ", "/later soon", "/later Fix the tests", "/later 0", "/later 0m Go", "/later -1 Go", "/later 24:00 Go", "/later 12:60 Go", "/later 2w Go", "/later 366d Go", "/later 99999999999999999999 Go"])("refuses %s", (value) => {
    expect(parseLaterCommand(value, now)).toBeUndefined();
  });

  it("writes a message back with the minutes it has left, at least one", () => {
    expect(laterCommand({ id: "a", prompt: "Go", at: now + 90 * MINUTE }, now)).toBe("/later 90m Go");
    expect(laterCommand({ id: "a", prompt: "Go", at: now + 30_001 }, now)).toBe("/later 1m Go");
    expect(laterCommand({ id: "a", prompt: "Go", at: now - HOUR, missed: true }, now)).toBe("/later 1m Go");
  });
});
