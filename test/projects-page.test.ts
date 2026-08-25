import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { filterAndSortProjects, filterProjectsByType } from "../src/renderer/projects.js";

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

  it("filters projects by their persisted type", () => {
    const interactiveDrama = project("story", "The Stopover", "2026-08-25T11:00:00Z", "interactive-drama");
    expect(filterProjectsByType([...PROJECTS, interactiveDrama], "general")).toEqual(PROJECTS);
    expect(filterProjectsByType([...PROJECTS, interactiveDrama], "interactive-drama")).toEqual([interactiveDrama]);
  });
});

function project(id: string, name: string, updatedAt: string, type: ProjectState["type"] = "general"): ProjectState {
  return { id, name, type, updatedAt, workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
