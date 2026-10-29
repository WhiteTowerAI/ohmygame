import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { recentAssetCanvasProjects } from "../src/renderer/asset-canvas-home.js";

describe("Asset Canvas home", () => {
  it("keeps only the eight most recently updated Asset Canvas projects", () => {
    const projects = [
      project("web", "web-game", "2026-09-30T12:00:00Z"),
      ...Array.from({ length: 10 }, (_, index) => project(`canvas-${index}`, "asset-canvas", `2026-09-${10 + index}T12:00:00Z`)),
    ];

    expect(recentAssetCanvasProjects(projects).map((item) => item.id)).toEqual([
      "canvas-9", "canvas-8", "canvas-7", "canvas-6", "canvas-5", "canvas-4", "canvas-3", "canvas-2",
    ]);
  });
});

function project(id: string, type: ProjectState["type"], updatedAt: string): ProjectState {
  return { id, name: id, type, updatedAt, workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
