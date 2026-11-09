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
const { ProjectPreviewSettings } =
  await import("../src/renderer/project-preview-settings.js");
const { ProjectGeneralSettings } =
  await import("../src/renderer/project-appearance-settings.js");
const { ProjectSettings } = await import("../src/renderer/project-settings.js");

describe("ProjectPreviewSettings", () => {
  it.each([false, true])(
    "shows the saved General Web preview switch: %s",
    (webPreviewEnabled) => {
      const html = renderToStaticMarkup(
        createElement(ProjectPreviewSettings, {
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

  it("keeps the saved startup and playtest settings in the form", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectPreviewSettings, {
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

    expect(html).toContain('value="apps/game"');
    expect(html).toContain('value="start"');
    expect(html).toContain("Package manager");
    expect(html).toContain("Default route");
    expect(html).toContain("Device");
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
        <ProjectPreviewSettings
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
});

describe("the project's settings", () => {
  const project = { id: "named", name: "Old name", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/named" } as ProjectState;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const type = (value: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>("input:not([type=file])")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const general = (onRename: (name: string) => void, shown = project) => act(async () => root.render(createElement(ProjectGeneralSettings, { project: shown, onRename })));
  const closeTab = () => act(async () => root.render(null));

  it("saves an edited name as the settings close", async () => {
    const onRename = vi.fn();
    await general(onRename);
    await type("  New name ");
    expect(onRename).not.toHaveBeenCalled();
    await closeTab();
    expect(onRename).toHaveBeenCalledWith("New name");
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty or unedited name alone, and a name the project got meanwhile", async () => {
    const onRename = vi.fn();
    await general(onRename);
    await type("   ");
    await closeTab();
    await general(onRename);
    await general(onRename, { ...project, name: "Space gardener" });
    await closeTab();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("saves a chosen icon and the template cover at once", async () => {
    vi.mocked(setProjectAppearance).mockImplementation(async (_id, appearance) => ({ ...project, appearance }));
    await general(() => {});
    const radio = (name: string) => host.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)!;
    // The default icons stay folded until asked for.
    expect(radio("Rocket")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".project-appearance-library-toggle")!.click());
    await act(async () => radio("Rocket").click());
    expect(setProjectAppearance).toHaveBeenLastCalledWith(project.id, { icon: "rocket" });
    expect(radio("Rocket").getAttribute("aria-checked")).toBe("true");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === "Template")!.click());
    expect(setProjectAppearance).toHaveBeenLastCalledWith(project.id, { icon: "rocket", cover: "template" });
  });

  describe("dialog", () => {
    const open = (props: { workspaceTab?: string; initialTab?: "general" | "workspace"; busy?: boolean; onClose?: () => void }) => act(async () => root.render(createElement(ProjectSettings, {
      project, initialTab: "general", workspaceRef: () => {}, busy: false, plugins: createElement("p", { className: "plugins-tab" }), onRename: () => {}, onClose: () => {}, ...props,
    })));
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('.project-settings [role="tab"]')];
    const panels = () => [...document.querySelectorAll<HTMLElement>(".project-settings-tab")];

    it("offers General and Plugins for every project, and a workspace's own tab between them", async () => {
      await open({});
      expect(tabs().map((tab) => tab.textContent)).toEqual(["General", "Plugins"]);
      await open({ workspaceTab: "Preview" });
      expect(tabs().map((tab) => tab.textContent)).toEqual(["General", "Preview", "Plugins"]);
    });

    it("keeps every tab mounted, hiding the ones not showing", async () => {
      await open({ workspaceTab: "Preview" });
      expect(panels().map((panel) => panel.hidden)).toEqual([false, true, true]);
      await act(async () => tabs()[2]!.click());
      expect(panels().map((panel) => panel.hidden)).toEqual([true, true, false]);
      expect(document.querySelector(".plugins-tab")).not.toBeNull();
    });

    it("falls back to General when the workspace's tab goes away", async () => {
      await open({ workspaceTab: "Preview", initialTab: "workspace" });
      expect(panels().map((panel) => panel.hidden)).toEqual([true, false, true]);
      await open({ workspaceTab: undefined, initialTab: "workspace" });
      expect(panels().map((panel) => panel.hidden)).toEqual([false, true]);
    });

    it("stays open while a tab saves", async () => {
      const onClose = vi.fn();
      await open({ busy: true, onClose });
      const close = document.querySelector<HTMLButtonElement>('.project-settings [aria-label="Close"]')!;
      expect(close.disabled).toBe(true);
      await act(async () => document.querySelector(".project-settings")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(onClose).not.toHaveBeenCalled();
      await open({ busy: false, onClose });
      await act(async () => close.click());
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
