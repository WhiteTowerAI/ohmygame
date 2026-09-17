import { describe, expect, it } from "vitest";
import type { StoryInteractionBehavior } from "../src/shared/contracts.js";
import { createStoryInteractionFiles } from "../src/shared/story-interaction-code.js";

describe("Interaction code templates", () => {
  it("creates a Continue surface", () => {
    const files = createStoryInteractionFiles({ type: "continue", label: "Board train" });
    expect(files.html).toContain('id="continue"');
    expect(files.html).toContain("Board train");
    expect(files.css).toContain("#continue");
    expect(files.javascript).toContain("ui.waitForClick");
  });

  it("creates a Hotspot surface", () => {
    const behavior: StoryInteractionBehavior = {
      type: "hotspot",
      durationMs: 5_000,
      label: "Open door",
      region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      success: { actions: [] },
      timeout: { actions: [] },
    };
    const files = createStoryInteractionFiles(behavior);
    expect(files.html).toContain('id="hotspot"');
    expect(files.css).toContain("left: 20%");
    expect(files.javascript).toContain('return "success"');
  });

  it("creates a QTE surface with its configured key", () => {
    const behavior: StoryInteractionBehavior = {
      type: "qte",
      durationMs: 3_000,
      prompt: "Dodge",
      key: "Space",
      success: { actions: [] },
      timeout: { actions: [] },
    };
    const files = createStoryInteractionFiles(behavior);
    expect(files.html).toContain("Dodge");
    expect(files.javascript).toContain('ui.waitForKey("Space")');
    expect(files.javascript).toContain('return "success"');
  });
});
