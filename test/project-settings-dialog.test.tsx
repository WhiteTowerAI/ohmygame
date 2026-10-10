import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSettingsDialog } from "../src/renderer/project-settings-dialog.js";

describe("ProjectSettingsDialog", () => {
  it.each([false, true])("shows the saved General Web preview switch: %s", (webPreviewEnabled) => {
    const html = renderToStaticMarkup(createElement(ProjectSettingsDialog, {
      project: { id: "general", name: "General", type: "general", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/general", webPreviewEnabled, preview: { status: "waiting" } },
      onClose: () => {}, onSaved: () => {},
    }));
    expect(html).toContain('role="switch" aria-label="Web preview"');
    expect(html.includes('checked=""')).toBe(webPreviewEnabled);
    expect(html.includes('fieldset class="project-settings-section" disabled=""')).toBe(!webPreviewEnabled);
  });

  it("keeps the project identity in the form and restores the browser-preview action", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSettingsDialog, {
        project: {
          id: "project-1",
          name: "Nested game",
          type: "web-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          startupDirectory: "apps/game",
          startupScript: "start",
          packageManager: "pnpm",
          previewPath: "/play",
          previewViewport: "mobile",
          preview: { status: "ready", url: "http://127.0.0.1:43121" },
        },
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    );

    expect(html).toContain("Project settings");
    expect(html).toContain("Nested game");
    expect(html).toContain('value="apps/game"');
    expect(html).toContain('value="start"');
    expect(html).toContain("Package manager");
    expect(html).toContain("Default route");
    expect(html).toContain("Device");
    expect(html).toContain("Open preview in browser");
    expect(html).not.toContain("Relative to the project root");
    expect(html).not.toContain("The selected folder must contain");
  });
});
