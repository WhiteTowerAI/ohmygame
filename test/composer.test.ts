import { describe, expect, it } from "vitest";
import { compactInstructions, matchesCompactCommand, matchesPlanCommand } from "../src/renderer/plan-mode-control.js";

describe("composer plan command", () => {
  it("matches only prefixes of the plan command", () => {
    expect(["/", "/p", "/PL", "/plan"].every(matchesPlanCommand)).toBe(true);
    expect(["", "plan", "/model", "/plan now"].some(matchesPlanCommand)).toBe(false);
  });
});

describe("composer compact command", () => {
  it("matches command prefixes and parses optional instructions", () => {
    expect(["/", "/c", "/compact", "/COMPACT"].every(matchesCompactCommand)).toBe(true);
    expect(matchesCompactCommand("/compact now")).toBe(true);
    expect(["", "compact"].some(matchesCompactCommand)).toBe(false);
    expect(matchesCompactCommand("/compac")).toBe(true);
    expect(compactInstructions("/compact")).toBeUndefined();
    expect(compactInstructions("/compact keep API decisions")).toBe("keep API decisions");
    expect(compactInstructions("/compac")).toBeNull();
  });
});
