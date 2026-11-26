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
const getCheckpointHistory = vi.fn<(...args: unknown[]) => Promise<{ bytes: number; removableBytes?: number; turns?: number }>>();
const clearCheckpointHistory = vi.fn<(...args: unknown[]) => Promise<void>>();
const getFileHistorySettings = vi.fn(async () => ({ autoClearDays: 0 }));
const setFileHistorySettings = vi.fn(async (autoClearDays: number) => ({ autoClearDays }));
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  inspectProjectPreview,
  updateProjectRunSettings,
  getProjectCover: vi.fn(async () => undefined),
  getProjectCoverState: vi.fn(async () => ({ mode: "auto" })),
  getProjectLogo: vi.fn(async () => undefined),
  getCheckpointHistory,
  clearCheckpointHistory,
  getFileHistorySettings,
  setFileHistorySettings,
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
const { FileHistoryAutoClear } = await import("../src/renderer/project-file-history.js");

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
    getCheckpointHistory.mockResolvedValue({ bytes: 0 });
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

  it("shows what the file history takes, and clears older history only after saying what that takes", async () => {
    getCheckpointHistory.mockResolvedValue({ bytes: 19133 });
    await general(() => {});
    const section = host.querySelector<HTMLElement>(".project-file-history")!;
    const free = section.querySelector<HTMLButtonElement>("button")!;
    expect(section.textContent).toContain("19 KB used");
    expect(free.disabled).toBe(false);

    // What the choice would free is read before the clear can be chosen.
    getCheckpointHistory.mockImplementation(async (_id, before) => before === undefined ? { bytes: 19133 } : { bytes: 19133, removableBytes: 15360, turns: 12 });
    const dialog = () => document.querySelector<HTMLElement>(".ui-dialog-sm")!;
    const clear = () => [...dialog().querySelectorAll<HTMLButtonElement>(".ui-dialog-footer button")].at(-1)!;
    await act(async () => free.click());
    expect(getCheckpointHistory).toHaveBeenLastCalledWith(project.id, expect.any(Number));
    expect(dialog().textContent).toContain("12turns lose Undo");
    expect(dialog().textContent).toContain("15 KBfreed");
    expect(dialog().textContent).toContain("can't be reversed");
    expect(clear().textContent).toBe("Clear 15 KB");
    expect(clear().disabled).toBe(false);
    expect(clearCheckpointHistory).not.toHaveBeenCalled();
    await act(async () => clear().click());
    expect(clearCheckpointHistory).toHaveBeenCalledWith(project.id, expect.any(Number));
    // The size is read again, and the dialog is gone.
    expect(getCheckpointHistory).toHaveBeenLastCalledWith(project.id);
    expect(dialog()).toBeNull();

    // Nothing to remove leaves the clear off, and so does a project without file history.
    getCheckpointHistory.mockImplementation(async (_id, before) => before === undefined ? { bytes: 19133 } : { bytes: 19133, removableBytes: 0, turns: 0 });
    await act(async () => free.click());
    expect(clear().textContent).toBe("Nothing to clear");
    expect(clear().disabled).toBe(true);

    // A custom date is picked on a calendar that opens over the dialog, up to today, and clears from that day's midnight.
    const custom = [...dialog().querySelectorAll<HTMLButtonElement>("[role=radio]")].find((button) => button.textContent === "Custom")!;
    await act(async () => custom.click());
    const calendar = () => document.querySelector<HTMLElement>(".project-file-history-popover");
    const days = [...calendar()!.querySelectorAll<HTMLButtonElement>(".project-file-history-calendar-grid button")];
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(days.find((button) => button.getAttribute("aria-pressed") === "true")?.textContent).toBe(String(start.getDate()));
    const today = new Date();
    const sameMonth = start.getMonth() === today.getMonth();
    expect(days.filter((button) => button.disabled).length).toBe(sameMonth ? days.length - today.getDate() : 0);
    await act(async () => days[0]!.click());
    expect(getCheckpointHistory).toHaveBeenLastCalledWith(project.id, new Date(start.getFullYear(), start.getMonth(), 1).getTime());
    // The calendar closes, and the choice names the date.
    expect(calendar()).toBeNull();
    expect(custom.textContent).not.toBe("Custom");
  });

  it("asks before clearing the file history automatically, and the project says that it is", async () => {
    await act(async () => root.render(createElement(FileHistoryAutoClear)));
    const select = host.querySelector<HTMLButtonElement>('button[aria-label="Clear old history automatically"]')!;
    expect(select.textContent).toContain("Off");
    const choose = async (label: string) => {
      await act(async () => select.click());
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === label)!.click());
    };
    const dialog = () => document.querySelector<HTMLElement>(".ui-dialog-sm");
    const footer = () => [...dialog()!.querySelectorAll<HTMLButtonElement>(".ui-dialog-footer button")];
    // Turning it on asks first, and nothing changes until it is confirmed.
    await choose("30 days");
    expect(dialog()!.textContent).toContain("older than 30 days");
    await act(async () => footer()[0]!.click());
    expect(dialog()).toBeNull();
    expect(setFileHistorySettings).not.toHaveBeenCalled();
    await choose("30 days");
    await act(async () => footer().at(-1)!.click());
    expect(setFileHistorySettings).toHaveBeenCalledWith(30);
    expect(select.textContent).toContain("30 days");
    // Keeping more needs no confirmation; keeping less asks again.
    await choose("1 year");
    expect(dialog()).toBeNull();
    expect(setFileHistorySettings).toHaveBeenLastCalledWith(365);
    await choose("7 days");
    expect(dialog()).not.toBeNull();

    getFileHistorySettings.mockResolvedValueOnce({ autoClearDays: 7 });
    await general(() => {});
    expect(host.querySelector(".project-file-history")!.textContent).toContain("older than 7 days is cleared automatically");
  });

  it("leaves the clear off for a project without file history", async () => {
    await general(() => {});
    const section = host.querySelector<HTMLElement>(".project-file-history")!;
    expect(section.textContent).toContain("0 B used");
    expect(section.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  });

  describe("dialog", () => {
    const open = (props: { workspaceTab?: string; initialTab?: "general" | "workspace"; busy?: boolean; onClose?: () => void }) => act(async () => root.render(createElement(ProjectSettings, {
      project, initialTab: "general", workspaceRef: () => {}, busy: false, onRename: () => {}, onClose: () => {}, ...props,
    })));
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('.project-settings [role="tab"]')];
    const panels = () => [...document.querySelectorAll<HTMLElement>(".project-settings-tab")];

    it("shows tabs only for a workspace with its own", async () => {
      await open({});
      expect(tabs()).toHaveLength(0);
      await open({ workspaceTab: "Preview" });
      expect(tabs().map((tab) => tab.textContent)).toEqual(["General", "Preview"]);
    });

    it("keeps both tabs mounted, hiding the one not showing", async () => {
      await open({ workspaceTab: "Preview" });
      expect(panels().map((panel) => panel.hidden)).toEqual([false, true]);
      await act(async () => tabs()[1]!.click());
      expect(panels().map((panel) => panel.hidden)).toEqual([true, false]);
    });

    it("falls back to General when the workspace's tab goes away", async () => {
      await open({ workspaceTab: "Preview", initialTab: "workspace" });
      expect(panels().map((panel) => panel.hidden)).toEqual([true, false]);
      await open({ workspaceTab: undefined, initialTab: "workspace" });
      expect(panels().map((panel) => panel.hidden)).toEqual([false]);
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
