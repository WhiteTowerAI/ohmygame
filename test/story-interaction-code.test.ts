import { describe, expect, it } from "vitest";
import { createStoryInteractionTemplate } from "../src/shared/story-interaction-code.js";

describe("Interaction code templates", () => {
  it("creates a Continue surface", () => {
    const { files, outcomes } = createStoryInteractionTemplate("continue");
    expect(files.html).toContain('id="continue"');
    expect(files.html).toContain("Continue");
    expect(files.css).toContain("#continue");
    expect(files.javascript).toContain("ui.waitForClick");
    expect(outcomes).toEqual(["continue"]);
  });

  it("creates a Hotspot surface", () => {
    const { files, outcomes, timeout } = createStoryInteractionTemplate("hotspot");
    expect(files.html).toContain('id="hotspot"');
    expect(files.css).toContain("left: 35%");
    expect(files.javascript).not.toContain("ui.waitForTimeout");
    expect(outcomes).toEqual(["success", "timeout"]);
    expect(timeout).toEqual({ durationMs: 5_000, outcome: "timeout" });
  });

  it("creates a QTE surface with its configured key", () => {
    const { files, outcomes, timeout } = createStoryInteractionTemplate("qte");
    expect(files.html).toContain("Act now");
    expect(files.javascript).toContain('ui.waitForKey("KeyE")');
    expect(files.javascript).not.toContain("ui.waitForTimeout");
    expect(outcomes).toEqual(["success", "timeout"]);
    expect(timeout).toEqual({ durationMs: 3_000, outcome: "timeout" });
  });
});
