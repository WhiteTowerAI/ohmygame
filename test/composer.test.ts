import { describe, expect, it } from "vitest";
import { matchesPlanCommand } from "../src/renderer/plan-mode-control.js";

describe("composer plan command", () => {
  it("matches only prefixes of the plan command", () => {
    expect(["/", "/p", "/PL", "/plan"].every(matchesPlanCommand)).toBe(true);
    expect(["", "plan", "/model", "/plan now"].some(matchesPlanCommand)).toBe(false);
  });
});
