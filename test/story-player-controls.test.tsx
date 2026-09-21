import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryPlayerControls, StoryPlayerPauseLayer } from "../src/renderer/story-player-controls.js";

describe("StoryPlayerControls", () => {
  it("omits disabled controls", () => {
    expect(renderToStaticMarkup(<StoryPlayerControls pause={false} mode="preview" />)).toBe("");
  });

  it("renders an inert preview and an interactive runtime control", () => {
    const preview = renderToStaticMarkup(<StoryPlayerControls pause mode="preview" />);
    const interactivePreview = renderToStaticMarkup(<StoryPlayerControls pause mode="preview" onPause={() => undefined} />);
    const runtime = renderToStaticMarkup(<StoryPlayerControls pause mode="runtime" onPause={() => undefined} />);

    expect(preview).toContain("story-player-controls is-preview");
    expect(preview).toContain('aria-hidden="true"');
    expect(preview).not.toContain("<button");
    expect(interactivePreview).toContain("story-player-controls is-preview is-interactive");
    expect(interactivePreview).toContain("<button");
    expect(runtime).toContain("story-player-controls is-runtime is-interactive");
    expect(runtime).toContain('<button class="story-player-pause"');
    expect(runtime).toContain('aria-label="Pause"');
    expect(runtime).not.toContain('fill="currentColor"');
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
