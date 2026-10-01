import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageModel, ProjectState, VideoModel } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  listImageModels: vi.fn(),
  listVideoModels: vi.fn(),
  updateAssetCanvas: vi.fn(),
}));

vi.mock("../src/renderer/api.js", () => api);

import { ASSET_CANVAS_QUICK_STARTS, availableQuickStarts, createAssetCanvasQuickStart } from "../src/renderer/asset-canvas-quick-start.js";

const starter = (key: string) => ASSET_CANVAS_QUICK_STARTS.find((item) => item.key === key)!;
const GPT_IMAGE = imageModel("openrouter", "openai/gpt-image-2.5-flare");
const NANO_BANANA = imageModel("openrouter", "google/gemini-3.1-flash-image", [{ resolution: "2K", aspectRatio: "16:9" }]);
const SEEDANCE_MINI = videoModel("bytedance/seedance-2.0-mini");
const SEEDANCE_25 = videoModel("bytedance/seedance-2.5");

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
    api.updateAssetCanvas.mockResolvedValue(undefined);
    api.listImageModels.mockResolvedValue([]);
    api.listVideoModels.mockResolvedValue([]);
  });

  it("lists generic starters first and only the model starters that are available", () => {
    expect(ASSET_CANVAS_QUICK_STARTS.map((item) => item.label)).toEqual([
      "Image", "Video", "3D", "GPT Image 2.5", "Nano Banana 2", "Seedance 2.0", "Seedance 2.5",
    ]);
    expect(availableQuickStarts([], []).map((item) => item.key)).toEqual(["image", "video", "model-3d"]);
    expect(availableQuickStarts(
      [imageModel("openai", "gpt-image-2.5-flare")],
      [SEEDANCE_MINI, SEEDANCE_25],
    ).map((item) => item.key)).toEqual(["image", "video", "model-3d", "gpt-image-2.5", "seedance-2.5"]);
  });

  it("creates a canvas with the selected image model and a setting it supports", async () => {
    api.listImageModels.mockResolvedValue([GPT_IMAGE, NANO_BANANA]);

    const result = await createAssetCanvasQuickStart(starter("nano-banana-2"));

    expect(api.createProject).toHaveBeenCalledWith({ type: "asset-canvas" });
    expect(api.updateAssetCanvas).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({
      nodes: [expect.objectContaining({ type: "image", data: expect.objectContaining({
        model: { provider: "openrouter", id: "google/gemini-3.1-flash-image" },
        resolution: "2K",
        aspectRatio: "16:9",
      }) })],
    }));
    expect(result.project).toBe(PROJECT);
    expect(result.nodeId).toBeTruthy();
  });

  it("uses the first available model for generic starters", async () => {
    api.listVideoModels.mockResolvedValue([SEEDANCE_MINI, SEEDANCE_25]);

    await createAssetCanvasQuickStart(starter("video"));

    expect(api.updateAssetCanvas).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({
      nodes: [expect.objectContaining({ type: "video", data: expect.objectContaining({ model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } }) })],
    }));
  });

  it("creates a generic starter without a model when none is configured", async () => {
    await createAssetCanvasQuickStart(starter("image"));

    expect(api.updateAssetCanvas).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({
      nodes: [expect.objectContaining({ type: "image", data: expect.not.objectContaining({ model: expect.anything() }) })],
    }));
  });

  it("does not create a project when the starter's model is unavailable", async () => {
    await expect(createAssetCanvasQuickStart(starter("gpt-image-2.5"))).rejects.toThrow("GPT Image 2.5 is not available");
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("removes a project when its starter canvas cannot be written", async () => {
    api.updateAssetCanvas.mockRejectedValue(new Error("Could not write canvas"));

    await expect(createAssetCanvasQuickStart(starter("video"))).rejects.toThrow("Could not write canvas");
    expect(api.deleteProject).toHaveBeenCalledWith(PROJECT.id);
  });

  it("reports when a failed starter project cannot be removed", async () => {
    api.updateAssetCanvas.mockRejectedValue(new Error("Could not write canvas"));
    api.deleteProject.mockRejectedValue(new Error("Could not delete project"));

    await expect(createAssetCanvasQuickStart(starter("model-3d"))).rejects.toThrow(
      "Could not write canvas. The empty canvas could not be removed.",
    );
  });
});

function imageModel(provider: string, id: string, generationOptions: ImageModel["generationOptions"] = [{ resolution: "1K", aspectRatio: "1:1" }]): ImageModel {
  return { provider, providerName: provider, id, name: id, sizes: [], generationOptions, supportsReferenceImage: false, maxOutputs: 1, protocol: "openrouter-images" };
}

function videoModel(id: string): VideoModel {
  return { provider: "openrouter", providerName: "OpenRouter", id, name: id, resolutions: ["720p"], aspectRatios: ["16:9"], durations: [5], maxImageReferences: 0 };
}
