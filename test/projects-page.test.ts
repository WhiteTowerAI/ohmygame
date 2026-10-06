import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { filterAndSortProjects } from "../src/renderer/projects.js";

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

function project(id: string, name: string, updatedAt: string, type: ProjectState["type"] = "web-game"): ProjectState {
  return { id, name, type, updatedAt, workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
