// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const exportProject = vi.fn<(projectId: string) => Promise<Blob>>();
const importProject = vi.fn<(file: File) => Promise<ProjectState>>();
const listProjects = vi.fn<() => Promise<ProjectState[]>>();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  exportProject,
  importProject,
  listProjects,
  listProjectActivity: async () => ({ activity: [], names: [] }),
  waitForRuntime: async () => undefined,
  getProjectCover: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/app-sidebar.tsx"), () => ({
  AppSidebar: () => null,
}));
const { ProjectCard } = await import("../src/renderer/project-card.js");
const { archiveProjectName } = await import("../src/renderer/api.js");
const { ProjectsPage } = await import("../src/renderer/projects.js");
const { runtimeConnection, updateRuntimeConnection } =
  await import("../src/renderer/runtime-connection.js");

const project: ProjectState = {
  id: "project-1",
  name: "Moon Garden",
  type: "web-game",
  updatedAt: "2026-10-20T12:00:00.000Z",
  workspacePath: "/projects/project-1/workspace",
  preview: { status: "waiting" },
};
const actions = {
  onRename: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
};

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let downloads: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  exportProject.mockReset();
  importProject.mockReset();
  listProjects.mockReset().mockResolvedValue([]);
  updateRuntimeConnection({
    status: "ready",
    generation: runtimeConnection().generation + 1,
    recovered: false,
  });
  downloads = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:archive");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <ProjectCard project={project} onOpen={() => {}} actions={actions} />,
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".project-card-menu")!.click();
  });
}

function menuItem(label: string): HTMLButtonElement {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label)!;
}

describe("project card export", () => {
  it("downloads the project archive under the project's name", async () => {
    exportProject.mockResolvedValue(new Blob(["zip"]));
    await openMenu();
    await act(async () => menuItem("Export project").click());
    expect(exportProject).toHaveBeenCalledWith("project-1");
    expect(downloads).toEqual(["Moon Garden.zip"]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("shows why an export failed", async () => {
    exportProject.mockRejectedValue(
      new Error("Wait for the agent to finish before exporting"),
    );
    await openMenu();
    await act(async () => menuItem("Export project").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Wait for the agent to finish before exporting",
    );
    expect(downloads).toEqual([]);
  });
});

describe("project import", () => {
  async function renderPage(): Promise<HTMLInputElement> {
    await act(async () => {
      root.render(
        <ProjectsPage
          onNavigate={() => {}}
          onOpenProject={() => {}}
          onFiltersChange={() => {}}
        />,
      );
    });
    return container.querySelector<HTMLInputElement>('input[type="file"]')!;
  }

  async function choose(input: HTMLInputElement, file: File): Promise<void> {
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("imports a chosen archive and shows the new project", async () => {
    const input = await renderPage();
    expect(
      container.querySelector('[aria-label="Import project"]'),
    ).not.toBeNull();
    importProject.mockImplementation(async () => {
      listProjects.mockResolvedValue([project]);
      return project;
    });
    const file = new File(["zip"], "Moon Garden.zip");

    await choose(input, file);

    expect(importProject).toHaveBeenCalledWith(file);
    expect(container.querySelector(".project-card-name")?.textContent).toBe(
      "Moon Garden",
    );
  });

  it("explains why an archive could not be imported", async () => {
    const input = await renderPage();
    importProject.mockRejectedValue(
      new Error("The file is not an OhMyGame project archive."),
    );

    await choose(input, new File(["zip"], "notes.zip"));

    expect(container.querySelector(".projects-notice")?.textContent).toBe(
      "The file is not an OhMyGame project archive.",
    );
  });

  it("refuses an archive over the size limit before uploading it", async () => {
    const input = await renderPage();
    const file = new File(["zip"], "huge.zip");
    Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 * 1024 });

    await choose(input, file);

    expect(importProject).not.toHaveBeenCalled();
    expect(container.querySelector(".projects-notice")?.textContent).toBe(
      "Choose a project archive up to 10 GB",
    );
  });
});

describe("archive project names", () => {
  it("names a story project file after the story, in either language", () => {
    expect(archiveProjectName("Night Train (project).zip")).toBe("Night Train");
    expect(archiveProjectName("夜行列车 (项目).zip")).toBe("夜行列车");
    expect(archiveProjectName("Night Train.ZIP")).toBe("Night Train");
    expect(archiveProjectName("Notes (draft).zip")).toBe("Notes (draft)");
  });
});
