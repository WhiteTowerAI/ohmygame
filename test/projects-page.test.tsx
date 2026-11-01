// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const listProjects = vi.fn<() => Promise<ProjectState[]>>();
const deleteProject = vi.fn<(projectId: string) => Promise<void>>();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects,
  deleteProject,
  streamProjectActivity: async () => undefined,
  waitForRuntime: async () => undefined,
  getProjectCover: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/page-frame.tsx"), () => ({
  PageFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const { filterAndSortProjects, ProjectsPage } = await import("../src/renderer/projects.js");
const { runtimeConnection, updateRuntimeConnection } = await import("../src/renderer/runtime-connection.js");

const PROJECTS: ProjectState[] = [
  project("forest", "Forest Adventure", "2026-08-23T10:00:00Z"),
  project("arcade", "Arcade Runner", "2026-08-25T10:00:00Z"),
  project("garden", "Garden Keepers", "2026-08-24T10:00:00Z"),
];

describe("project filtering and sorting", () => {
  it("searches project names case-insensitively", () => {
    expect(filterAndSortProjects(PROJECTS, "GARDEN", "updated").map(({ id }) => id)).toEqual(["garden"]);
  });

  it("sorts by most recently updated by default", () => {
    expect(filterAndSortProjects(PROJECTS, "", "updated").map(({ id }) => id)).toEqual(["arcade", "garden", "forest"]);
  });

  it("sorts names alphabetically", () => {
    expect(filterAndSortProjects(PROJECTS, "", "name").map(({ id }) => id)).toEqual(["arcade", "forest", "garden"]);
  });

  it("combines project type, search, and sorting without changing the input", () => {
    const projects = [...PROJECTS, project("story", "Garden Story", "2026-09-01T10:00:00Z", "interactive-story")];
    const originalIds = projects.map(({ id }) => id);
    expect(filterAndSortProjects(projects, "garden", "updated", "web-game").map(({ id }) => id)).toEqual(["garden"]);
    expect(filterAndSortProjects(projects, "garden", "updated", "interactive-story").map(({ id }) => id)).toEqual(["story"]);
    expect(filterAndSortProjects(projects, "", "updated", "godot-game")).toEqual([]);
    expect(projects.map(({ id }) => id)).toEqual(originalIds);
  });
});

describe("Projects page", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  const onFiltersChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    listProjects.mockReset().mockResolvedValue(PROJECTS);
    deleteProject.mockReset().mockResolvedValue();
    onFiltersChange.mockReset();
    updateRuntimeConnection({ status: "ready", generation: runtimeConnection().generation + 1, recovered: false });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(query = ""): Promise<void> {
    await act(async () => root.render(<ProjectsPage query={query} onNavigate={() => {}} onOpenProject={() => {}} onFiltersChange={onFiltersChange} />));
  }
  const names = () => [...container.querySelectorAll(".project-card-name")].map((name) => name.textContent);
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;

  it("gives its search field the id the sidebar's Search focuses", async () => {
    await render();
    const field = document.querySelector<HTMLInputElement>("#projects-search-input");
    expect(field?.getAttribute("aria-label")).toBe("Search projects");
  });

  it("switches to the list and keeps the choice for next time", async () => {
    await render();
    expect(container.querySelector(".projects-grid")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="radio"]:has([aria-label="List"])')!.click());
    expect(container.querySelector(".projects-grid")).toBeNull();
    expect(container.querySelectorAll(".project-row")).toHaveLength(3);
    expect(names()).toEqual(["Arcade Runner", "Garden Keepers", "Forest Adventure"]);
    expect(container.querySelector(".project-row-type")?.textContent).toBe("Web Game");

    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelectorAll(".project-row")).toHaveLength(3);
  });

  it("asks before removing a project, says it deletes its files outside the desktop app, and reloads the list", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Project actions for Garden Keepers"]')!.click());
    await act(async () => button("Remove from OhMyGame").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Remove “Garden Keepers” from OhMyGame?");
    expect(dialog.textContent).toContain("Its files will be deleted permanently.");
    listProjects.mockResolvedValue(PROJECTS.filter(({ id }) => id !== "garden"));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent === "Delete")!.click());
    expect(deleteProject).toHaveBeenCalledWith("garden");
    expect(names()).toEqual(["Arcade Runner", "Forest Adventure"]);
  });

  it("puts a project's files in the Trash in the desktop app", async () => {
    vi.stubGlobal("ohMyGameDesktop", { platform: "darwin", removeProject: vi.fn() });
    try {
      await render();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Project actions for Garden Keepers"]')!.click());
      await act(async () => button("Remove from OhMyGame").click());
      expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Its files go to the Trash");
      expect([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].map((item) => item.textContent)).toContain("Remove");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears a search that matches nothing", async () => {
    await render("castle");
    expect(container.textContent).toContain("No projects match your search");
    await act(async () => button("Clear filters").click());
    expect(onFiltersChange).toHaveBeenCalledWith({ sort: "updated" });
  });
});

function project(id: string, name: string, updatedAt: string, type: ProjectState["type"] = "web-game"): ProjectState {
  return { id, name, type, updatedAt, workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
