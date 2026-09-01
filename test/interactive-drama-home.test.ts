import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { recentInteractiveDramaProjects } from "../src/renderer/interactive-drama-home.js";

const PROJECTS = [
  project("web", "Web Game", "web-game", "2026-08-31T12:00:00Z"),
  project("older-drama", "Older Drama", "interactive-drama", "2026-08-29T12:00:00Z"),
  project("latest-drama", "Latest Drama", "interactive-drama", "2026-08-30T12:00:00Z"),
] satisfies ProjectState[];

describe("Interactive Drama home", () => {
  it("shows Drama projects by most recently updated", () => {
    expect(recentInteractiveDramaProjects(PROJECTS).map((project) => project.id)).toEqual(["latest-drama", "older-drama"]);
  });

  it("does not include another project type", () => {
    expect(recentInteractiveDramaProjects(PROJECTS.filter((item) => item.type !== "interactive-drama"))).toEqual([]);
  });

  it("limits the result to four projects", () => {
    const projects = Array.from({ length: 6 }, (_, index) => project(`drama-${index}`, `Drama ${index}`, "interactive-drama", `2026-08-${20 + index}T12:00:00Z`));
    expect(recentInteractiveDramaProjects(projects).map((item) => item.id)).toEqual(["drama-5", "drama-4", "drama-3", "drama-2"]);
  });
});

function project(id: string, name: string, type: ProjectState["type"], updatedAt: string): ProjectState {
  return { id, name, type, updatedAt, workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
