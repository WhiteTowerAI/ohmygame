import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageModel, ProjectState, VideoModel } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  listImageModels: vi.fn(),
  listVideoModels: vi.fn(),
  getCanvasWorkspace: vi.fn(),
  getCanvasBoard: vi.fn(),
  saveCanvasBoard: vi.fn(),
  waitForRuntime: vi.fn(),
}));

vi.mock("../src/renderer/api.js", () => api);
vi.mock("../src/renderer/canvas-api.js", () => api);

type QuickStartModule = typeof import("../src/renderer/asset-canvas-quick-start.js");

// The module caches model lists, so each test gets a fresh copy.
let quickStart: QuickStartModule;
const starter = (key: string) => quickStart.ASSET_CANVAS_QUICK_STARTS.find((item) => item.key === key)!;
const createAssetCanvasQuickStart: QuickStartModule["createAssetCanvasQuickStart"] = (item) => quickStart.createAssetCanvasQuickStart(item);
const GPT_IMAGE = imageModel("openrouter", "openai/gpt-image-2.5-flare");
const NANO_BANANA = imageModel("openrouter", "google/gemini-3.1-flash-image", [{ resolution: "2K", aspectRatio: "16:9" }]);
const SEEDANCE_MINI = videoModel("bytedance/seedance-2.0-mini");
const SEEDANCE_25 = videoModel("bytedance/seedance-2.5");
const OFFICIAL_SEEDANCE_20 = videoModel("doubao-seedance-2-0-260128", "volcengine-ark");
const OFFICIAL_SEEDANCE_25 = videoModel("dreamina-seedance-2-5-260628", "byteplus-modelark");

const PROJECT: ProjectState = {
  id: "canvas-1",
  name: "Untitled asset canvas",
  type: "asset-canvas",
  updatedAt: "2026-09-24T12:00:00Z",
  workspacePath: "/projects/canvas-1",
  preview: { status: "waiting" },
};

describe("Asset Canvas quick start", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    quickStart = await import("../src/renderer/asset-canvas-quick-start.js");
    api.waitForRuntime.mockResolvedValue(undefined);
    api.createProject.mockResolvedValue(PROJECT);
    api.deleteProject.mockResolvedValue(undefined);
    api.getCanvasWorkspace.mockResolvedValue({ boards: [{ id: "board-1" }] });
    api.getCanvasBoard.mockResolvedValue({ board: { id: "board-1" }, revision: "initial" });
    api.saveCanvasBoard.mockResolvedValue(undefined);
    api.listImageModels.mockResolvedValue([]);
    api.listVideoModels.mockResolvedValue([]);
  });

  it("lists generic starters first, then every model starter", () => {
    expect(quickStart.ASSET_CANVAS_QUICK_STARTS.map((item) => item.label)).toEqual([
      "Image", "Video", "3D", "GPT Image 2.5", "Nano Banana 2", "Seedance 2.0", "Seedance 2.5",
    ]);
  });

  it("creates a canvas with the selected image model and a setting it supports", async () => {
    api.listImageModels.mockResolvedValue([GPT_IMAGE, NANO_BANANA]);

    const result = await createAssetCanvasQuickStart(starter("nano-banana-2"));

    expect(api.createProject).toHaveBeenCalledWith({ type: "asset-canvas" });
    expect(api.saveCanvasBoard).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({ revision: "initial", board: expect.objectContaining({ id: "board-1",
      nodes: [expect.objectContaining({ type: "image", data: expect.objectContaining({
        model: { provider: "openrouter", id: "google/gemini-3.1-flash-image" },
        resolution: "2K",
        aspectRatio: "16:9",
      }) })],
    }) }));
    expect(result.project).toBe(PROJECT);
    expect(result.nodeId).toBeTruthy();
  });

  it("uses the first available model for generic starters", async () => {
    api.listVideoModels.mockResolvedValue([SEEDANCE_MINI, SEEDANCE_25]);

    await createAssetCanvasQuickStart(starter("video"));

    expect(api.saveCanvasBoard).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({ board: expect.objectContaining({
      nodes: [expect.objectContaining({ type: "video", data: expect.objectContaining({ model: { provider: "openrouter", id: "bytedance/seedance-2.0-mini" } }) })],
    }) }));
  });

  it.each([
    ["seedance-2.0", OFFICIAL_SEEDANCE_20],
    ["seedance-2.5", OFFICIAL_SEEDANCE_25],
  ])("recognizes official models for the %s starter", async (starterKey, model) => {
    api.listVideoModels.mockResolvedValue([model]);

    await createAssetCanvasQuickStart(starter(starterKey));

    expect(api.saveCanvasBoard).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({ board: expect.objectContaining({
      nodes: [expect.objectContaining({ type: "video", data: expect.objectContaining({ model: { provider: model.provider, id: model.id } }) })],
    }) }));
  });

  it("creates a generic starter without a model when none is configured", async () => {
    await createAssetCanvasQuickStart(starter("image"));

    expect(api.saveCanvasBoard).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({ board: expect.objectContaining({
      nodes: [expect.objectContaining({ type: "image", data: expect.not.objectContaining({ model: expect.anything() }) })],
    }) }));
  });

  it("does not create a project when no provider offers the starter's model", async () => {
    const created = createAssetCanvasQuickStart(starter("gpt-image-2.5"));

    await expect(created).rejects.toBeInstanceOf(quickStart.QuickStartModelUnavailableError);
    await expect(created).rejects.toThrow("GPT Image 2.5 needs a provider that offers it.");
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("reuses loaded models, and looks again when a starter's model is missing", async () => {
    await quickStart.loadQuickStartModels();
    await createAssetCanvasQuickStart(starter("image"));
    expect(api.listImageModels).toHaveBeenCalledTimes(1);

    api.listImageModels.mockResolvedValue([GPT_IMAGE]);
    await createAssetCanvasQuickStart(starter("gpt-image-2.5"));

    expect(api.listImageModels).toHaveBeenCalledTimes(2);
    expect(api.saveCanvasBoard).toHaveBeenLastCalledWith(PROJECT.id, expect.objectContaining({ board: expect.objectContaining({
      nodes: [expect.objectContaining({ data: expect.objectContaining({ model: { provider: "openrouter", id: "openai/gpt-image-2.5-flare" } }) })],
    }) }));
  });

  it("removes a project when its starter canvas cannot be written", async () => {
    api.saveCanvasBoard.mockRejectedValue(new Error("Could not write canvas"));

    await expect(createAssetCanvasQuickStart(starter("video"))).rejects.toThrow("Could not write canvas");
    expect(api.deleteProject).toHaveBeenCalledWith(PROJECT.id);
  });

  it("reports when a failed starter project cannot be removed", async () => {
    api.saveCanvasBoard.mockRejectedValue(new Error("Could not write canvas"));
    api.deleteProject.mockRejectedValue(new Error("Could not delete project"));

    await expect(createAssetCanvasQuickStart(starter("model-3d"))).rejects.toThrow(
      "Could not write canvas. The empty canvas could not be removed.",
    );
  });
});

function imageModel(provider: string, id: string, generationOptions: ImageModel["generationOptions"] = [{ resolution: "1K", aspectRatio: "1:1" }]): ImageModel {
  return { provider, providerName: provider, id, name: id, sizes: [], generationOptions, supportsReferenceImage: false, maxOutputs: 1, protocol: "openrouter-images" };
}

function videoModel(id: string, provider = "openrouter"): VideoModel {
  return { provider, providerName: provider, id, name: id, resolutions: ["720p"], aspectRatios: ["16:9"], durations: [5], maxImageReferences: 0 };
}
