import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryPlayerControls, StoryPlayerPauseLayer } from "../src/renderer/story-player-controls.js";

describe("StoryPlayerControls", () => {
  it("renders the shared pause control", () => {
    const html = renderToStaticMarkup(<StoryPlayerControls onPause={() => undefined} />);
    expect(html).toContain('class="story-player-controls"');
    expect(html).toContain('<button class="story-player-pause"');
    expect(html).toContain('aria-label="Pause"');
    expect(html).not.toContain('fill="currentColor"');
  });

  it("renders shared pause content", () => {
    const preview = renderToStaticMarkup(<StoryPlayerPauseLayer><button type="button">Resume</button></StoryPlayerPauseLayer>);
    const runtime = renderToStaticMarkup(<StoryPlayerPauseLayer modal><button type="button">Resume</button></StoryPlayerPauseLayer>);

    expect(preview).toContain('role="group"');
    expect(preview).toContain('aria-label="Preview paused"');
    expect(preview).not.toContain("aria-modal");
    expect(runtime).toContain('role="dialog"');
    expect(runtime).toContain('aria-modal="true"');
    expect(runtime).toContain("Paused");
    expect(runtime).toContain("Resume");
  });
});
