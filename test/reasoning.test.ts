import { describe, expect, it } from "vitest";
import { clampReasoningLevel, parseReasoningLevel } from "../src/shared/reasoning.js";

describe("reasoning levels", () => {
  it("clamps to the nearest supported Pi level", () => {
    expect(clampReasoningLevel("xhigh", ["off", "low", "medium", "high"])).toBe("high");
    expect(clampReasoningLevel("minimal", ["off", "low", "medium", "high"])).toBe("low");
  });

  it("rejects unknown persisted values", () => {
    expect(parseReasoningLevel("turbo")).toBeUndefined();
  });
});
