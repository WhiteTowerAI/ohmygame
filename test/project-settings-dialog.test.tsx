// @vitest-environment happy-dom
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
const inspectProjectPreview = vi.fn(async () => ({}));
const updateProjectRunSettings = vi.fn<() => Promise<ProjectState>>();
const setProjectAppearance = vi.fn<(id: string, appearance: object) => Promise<ProjectState>>();
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  inspectProjectPreview,
  updateProjectRunSettings,
  getProjectCover: vi.fn(async () => undefined),
  getProjectCoverState: vi.fn(async () => ({ mode: "auto" })),
  getProjectLogo: vi.fn(async () => undefined),
  setProjectAppearance,
  setProjectCover: vi.fn(),
  setProjectCoverMode: vi.fn(),
  setProjectLogo: vi.fn(),
}));
const { ProjectSettingsDialog } =
  await import("../src/renderer/project-settings-dialog.js");
const { ProjectAppearanceDialog } =
  await import("../src/renderer/project-appearance-settings.js");

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
      expect(html).toContain(
        `role="switch" aria-checked="${webPreviewEnabled}" aria-label="Web preview"`,
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

  it.each(["tablet", "mobile-landscape"])("does not reinspect startup configuration when route and device change to %s", async (previewViewport) => {
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).toHaveBeenCalledTimes(1);
    await change("Default route", "/new-route");
    await change("Device", previewViewport);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(inspectProjectPreview).toHaveBeenCalledTimes(1);
    await save();
    expect(updateProjectRunSettings).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({
        previewPath: "/new-route",
        previewViewport,
      }),
    );
  });

  it("saves a chosen icon and the template cover at once, without saving the form", async () => {
    vi.mocked(setProjectAppearance).mockImplementation(async (_id, appearance) => ({ ...project, appearance }));
    const radio = (name: string) => container.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)!;
    // The default icons stay folded until asked for.
    expect(radio("Rocket")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".project-appearance-library-toggle")!.click());
    await act(async () => radio("Rocket").click());
    expect(setProjectAppearance).toHaveBeenLastCalledWith(project.id, { icon: "rocket" });
    expect(radio("Rocket").getAttribute("aria-checked")).toBe("true");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === "Template")!.click());
    expect(setProjectAppearance).toHaveBeenLastCalledWith(project.id, { icon: "rocket", cover: "template" });
    expect(updateProjectRunSettings).not.toHaveBeenCalled();
  });
});

describe("ProjectAppearanceDialog", () => {
  const project = { id: "named", name: "Old name", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/named" } as ProjectState;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  // Each opening is a fresh dialog, as the project shell mounts it.
  let opening = 0;
  const open = async (onRename: (name: string) => void, onClose = vi.fn(), shown = project) => {
    await act(async () => root.render(createElement(ProjectAppearanceDialog, { key: ++opening, project: shown, open: true, onClose, onRename })));
    return onClose;
  };
  const type = (value: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement>(".project-appearance-name input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const done = () => act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Done")!.click());

  it("edits the name beside the appearance and saves it as it closes", async () => {
    const onRename = vi.fn();
    const onClose = await open(onRename);
    expect(document.querySelector(".ui-dialog")?.textContent).toContain("Name and appearance");
    expect(document.querySelector<HTMLInputElement>(".project-appearance-name input")!.value).toBe("Old name");
    await type("  New name ");
    await done();
    expect(onRename).toHaveBeenCalledWith("New name");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves an unchanged or empty name alone", async () => {
    const onRename = vi.fn();
    await open(onRename);
    await type("   ");
    await done();
    await open(onRename);
    await done();
    // A name the project got while the dialog was open isn't put back.
    await open(onRename);
    await act(async () => root.render(createElement(ProjectAppearanceDialog, { key: opening, project: { ...project, name: "Space gardener" }, open: true, onClose: () => {}, onRename })));
    await done();
    expect(onRename).not.toHaveBeenCalled();
  });
});
