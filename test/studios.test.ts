import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { recentStudioProjects } from "../src/renderer/studios.js";

describe("studio project lists", () => {
  it("keeps projects in their own Studio and orders them by recent activity", () => {
    const projects = [
      project("web-old", "web-game", "2026-08-01T00:00:00Z"),
      project("story", "interactive-story", "2026-10-01T00:00:00Z"),
      project("web-new", "web-game", "2026-09-01T00:00:00Z"),
      project("godot", "godot-game", "2026-09-02T00:00:00Z"),
      project("general", "general", "2026-10-01T00:00:00Z"),
    ];
    expect(
      recentStudioProjects(projects, "web-game", 1).map(({ id }) => id),
    ).toEqual(["web-new"]);
    expect(
      recentStudioProjects(projects, "godot-game").map(({ id }) => id),
    ).toEqual(["godot"]);
    expect(recentStudioProjects(projects, "general").map(({ id }) => id)).toEqual(["general"]);
    expect(projects.map(({ id }) => id)).toEqual([
      "web-old",
      "story",
      "web-new",
      "godot",
      "general",
    ]);
  });

  it("orders Story projects by recent activity and excludes other types", () => {
    const projects = [
      project("web", "web-game", "2026-10-01T00:00:00Z"),
      project("older-story", "interactive-story", "2026-08-29T00:00:00Z"),
      project("latest-story", "interactive-story", "2026-08-30T00:00:00Z"),
    ];
    expect(recentStudioProjects(projects, "interactive-story").map(({ id }) => id)).toEqual(["latest-story", "older-story"]);
    expect(recentStudioProjects(projects, "godot-game")).toEqual([]);
  });

  it("limits each Studio to four recent projects by default", () => {
    const projects = Array.from({ length: 6 }, (_, index) => project(`story-${index}`, "interactive-story", `2026-08-${20 + index}T00:00:00Z`));
    expect(recentStudioProjects(projects, "interactive-story").map(({ id }) => id)).toEqual(["story-5", "story-4", "story-3", "story-2"]);
  });
});

function project(
  id: string,
  type: ProjectState["type"],
  updatedAt: string,
): ProjectState {
  return {
    id,
    name: id,
    type,
    updatedAt,
    workspacePath: `/projects/${id}`,
    preview: { status: "waiting" },
  };
}
