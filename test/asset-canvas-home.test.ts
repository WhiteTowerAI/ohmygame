import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { createAssetCanvasStarterStory, isStoryDocument } from "../src/shared/story.js";
import { recentAssetCanvasProjects } from "../src/renderer/asset-canvas-home.js";

describe("Asset Canvas home", () => {
  it("creates a valid one-node story for every quick start", () => {
    for (const type of ["image", "video", "model-3d"] as const) {
      const imageModel = type === "image" ? { provider: "openrouter", id: "openai/gpt-image-2.5-flare" } : undefined;
      const { story, nodeId } = createAssetCanvasStarterStory(type, imageModel);

      expect(story.chapter.nodes).toHaveLength(1);
      expect(story.chapter.nodes[0]).toMatchObject({ id: nodeId, type, position: { x: 96, y: 96 } });
      if (type === "video") expect(story.chapter.nodes[0]).toMatchObject({ data: { prompt: "", resolution: "720p", aspectRatio: "adaptive", duration: 6 } });
      expect(story.editorLayout.nodes[nodeId]).toEqual({ x: 96, y: 96 });
      expect(isStoryDocument(story)).toBe(true);
    }
  });

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
