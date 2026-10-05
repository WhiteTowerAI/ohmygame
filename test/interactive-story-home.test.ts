import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { recentInteractiveStoryProjects } from "../src/renderer/interactive-story-home.js";

const PROJECTS = [
  project("web", "Web Game", "web-game", "2026-08-31T12:00:00Z"),
  project("older-story", "Older Story", "interactive-story", "2026-08-29T12:00:00Z"),
  project("latest-story", "Latest Story", "interactive-story", "2026-08-30T12:00:00Z"),
] satisfies ProjectState[];

describe("Interactive Story home", () => {
  it("shows Story projects by most recently updated", () => {
    expect(recentInteractiveStoryProjects(PROJECTS).map((project) => project.id)).toEqual(["latest-story", "older-story"]);
  });

  it("does not include another project type", () => {
    expect(recentInteractiveStoryProjects(PROJECTS.filter((item) => item.type !== "interactive-story"))).toEqual([]);
  });

  it("limits the result to four projects", () => {
    const projects = Array.from({ length: 6 }, (_, index) => project(`story-${index}`, `Story ${index}`, "interactive-story", `2026-08-${20 + index}T12:00:00Z`));
    expect(recentInteractiveStoryProjects(projects).map((item) => item.id)).toEqual(["story-5", "story-4", "story-3", "story-2"]);
  });
});

function project(id: string, name: string, type: ProjectState["type"], updatedAt: string): ProjectState {
  return { id, name, type, updatedAt, workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
