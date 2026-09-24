import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  listImageModels: vi.fn(),
  updateStory: vi.fn(),
}));

vi.mock("../src/renderer/api.js", () => api);

import { createAssetCanvasQuickStart } from "../src/renderer/asset-canvas-quick-start.js";

const PROJECT: ProjectState = {
  id: "canvas-1",
  name: "Untitled asset canvas",
  type: "asset-canvas",
  updatedAt: "2026-09-24T12:00:00Z",
  workspacePath: "/projects/canvas-1",
  preview: { status: "waiting" },
};

describe("Asset Canvas quick start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createProject.mockResolvedValue(PROJECT);
    api.deleteProject.mockResolvedValue(undefined);
    api.updateStory.mockResolvedValue(undefined);
    api.listImageModels.mockResolvedValue([]);
  });

  it("creates a canvas with the selected image model", async () => {
    api.listImageModels.mockResolvedValue([{ provider: "ohmygame", id: "gpt-image-2.5-flare" }]);

    const result = await createAssetCanvasQuickStart("image");

    expect(api.createProject).toHaveBeenCalledWith({ type: "asset-canvas" });
    expect(api.updateStory).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({
      chapter: expect.objectContaining({
        nodes: [expect.objectContaining({ type: "image", data: expect.objectContaining({ model: { provider: "ohmygame", id: "gpt-image-2.5-flare" } }) })],
      }),
    }));
    expect(result.project).toBe(PROJECT);
    expect(result.nodeId).toBeTruthy();
  });

  it("does not create a project when GPT Image 2.5 is unavailable", async () => {
    await expect(createAssetCanvasQuickStart("image")).rejects.toThrow("GPT Image 2.5 is not available");
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("removes a project when its starter story cannot be written", async () => {
    api.updateStory.mockRejectedValue(new Error("Could not write story"));

    await expect(createAssetCanvasQuickStart("video")).rejects.toThrow("Could not write story");
    expect(api.deleteProject).toHaveBeenCalledWith(PROJECT.id);
  });

  it("reports when a failed starter project cannot be removed", async () => {
    api.updateStory.mockRejectedValue(new Error("Could not write story"));
    api.deleteProject.mockRejectedValue(new Error("Could not delete project"));

    await expect(createAssetCanvasQuickStart("model-3d")).rejects.toThrow(
      "Could not write story. The empty canvas could not be removed.",
    );
  });
});
