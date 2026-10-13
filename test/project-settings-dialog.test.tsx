// @vitest-environment happy-dom
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
const inspectProjectPreview = vi.fn(async () => ({}));
const updateProjectRunSettings = vi.fn<() => Promise<ProjectState>>();
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  inspectProjectPreview,
  updateProjectRunSettings,
}));
const { ProjectSettingsDialog } =
  await import("../src/renderer/project-settings-dialog.js");

describe("ProjectSettingsDialog", () => {
  it.each([false, true])(
    "shows the saved General Web preview switch: %s",
    (webPreviewEnabled) => {
      const html = renderToStaticMarkup(
        createElement(ProjectSettingsDialog, {
          project: {
            id: "general",
            name: "General",
            type: "general",
            updatedAt: new Date(0).toISOString(),
            workspacePath: "/tmp/general",
            webPreviewEnabled,
            preview: { status: "waiting" },
          },
          onClose: () => {},
          onSaved: () => {},
        }),
      );
      expect(html).toContain('role="switch" aria-label="Web preview"');
      expect(/aria-label="Web preview"[^>]*checked=""/.test(html)).toBe(
        webPreviewEnabled,
      );
      expect(
        html.includes('fieldset class="project-settings-section" disabled=""'),
      ).toBe(!webPreviewEnabled);
    },
  );

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

describe("preview settings drafts", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  const project: ProjectState = {
    id: "general",
    name: "General",
    type: "general",
    webPreviewEnabled: true,
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/general",
    startupDirectory: "client",
    startupScript: "start",
    packageManager: "pnpm",
    previewMode: "script",
    previewArguments: ["--host", "{host}"],
    previewPort: 4200,
    previewCommand: "python3 -m http.server {port}",
    previewPath: "/play",
    previewViewport: "mobile",
    preview: { status: "waiting" },
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    vi.mocked(updateProjectRunSettings).mockResolvedValue(project);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectSettingsDialog
          project={project}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function change(label: string, value: string) {
    const field = [...container.querySelectorAll("label")]
      .find(
        (labelElement) =>
          labelElement.querySelector("span")?.textContent === label,
      )!
      .querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
    await act(async () => {
      if (field instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        field.value = value;
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }
  async function save() {
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  }

  it.each(["static", "command"])(
    "ignores invalid script drafts for %s during inspection and save",
    async (mode) => {
      await change("Script arguments", "[");
      await change("Startup script", "invalid script name");
      await change("Preview mode", mode);
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(inspectProjectPreview).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          previewMode: mode,
          startupScript: "start",
          previewArguments: project.previewArguments,
        }),
      );
      await save();
      expect(updateProjectRunSettings).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          previewMode: mode,
          previewArguments: project.previewArguments,
          startupScript: "start",
        }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("reports invalid arguments while script mode is active", async () => {
    await change("Script arguments", "[");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Arguments must be a JSON array of strings.",
    );
    await save();
    expect(updateProjectRunSettings).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Arguments must be a JSON array of strings.",
    );
  });

  it("disables preview without saving invalid disabled drafts or losing saved configuration", async () => {
    await change("Script arguments", "[");
    await change("Startup directory", "../outside");
    await change("Default route", "https://external.example");
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[aria-label="Web preview"]')!
        .click(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).not.toHaveBeenCalled();
    await save();
    expect(updateProjectRunSettings).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        webPreviewEnabled: false,
        previewMode: "script",
        startupDirectory: "client",
        startupScript: "start",
        previewArguments: project.previewArguments,
        previewPort: 4200,
        previewPath: "/play",
        previewViewport: "mobile",
      }),
    );
  });

  it("does not reinspect startup configuration when route and device change", async () => {
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).toHaveBeenCalledTimes(1);
    await change("Default route", "/new-route");
    await change("Device", "tablet");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).toHaveBeenCalledTimes(1);
    await save();
    expect(updateProjectRunSettings).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        previewPath: "/new-route",
        previewViewport: "tablet",
      }),
    );
  });
});
