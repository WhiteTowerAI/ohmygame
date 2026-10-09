import { describe, expect, it } from "vitest";
import type { ImageModel, VideoModel, Model3DModel } from "../src/shared/contracts.js";
import { applyRememberedSettings, nodeGenerationSettings } from "../src/renderer/asset-canvas-workspace.js";

type FlowNode = Parameters<typeof applyRememberedSettings>[0];

const openRouterImage = { provider: "openrouter", id: "gpt-image-2", name: "GPT Image 2", providerName: "OpenRouter", generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }] } as unknown as ImageModel;
const openAIImage = {
  provider: "openai",
  id: "gpt-image-2",
  name: "GPT Image 2",
  providerName: "OpenAI",
  generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }, { resolution: "2K", aspectRatio: "16:9" }],
} as unknown as ImageModel;
const video = { provider: "fal", id: "kling", name: "Kling", providerName: "fal", resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16"], durations: [5, 10], maxImageReferences: 1 } as unknown as VideoModel;
const catalogs = { imageModels: [openRouterImage, openAIImage], videoModels: [video], textModels: [] };

function imageNode(data: FlowNode["data"] = {}): FlowNode {
  return { id: "image-1", type: "image", position: { x: 0, y: 0 }, data: { prompt: "", images: [], model: { provider: "openrouter", id: "gpt-image-2" }, resolution: "1K", aspectRatio: "1:1", ...data } };
}

describe("Asset Canvas remembered settings", () => {
  it("remembers text reasoning and adjusts it when the model's supported levels change", () => {
    const model = { provider: "openai", id: "gpt-test", name: "GPT Test", providerName: "OpenAI", reasoningLevels: ["off", "high"] as const };
    const base: FlowNode = { id: "text-1", type: "text", position: { x: 0, y: 0 }, data: { text: "", instruction: "" } };
    const settings = nodeGenerationSettings({ type: "text", data: { textModel: model, reasoningLevel: "xhigh" } });
    expect(settings).toMatchObject({ reasoningLevel: "xhigh" });
    expect(applyRememberedSettings(base, settings, { ...catalogs, textModels: [{ ...model, reasoningLevels: [...model.reasoningLevels] }] }).data).toMatchObject({ textModel: { provider: "openai", id: "gpt-test" }, reasoningLevel: "high" });
  });
  it("starts a new image node with the last picked model and options", () => {
    const settings = nodeGenerationSettings(imageNode({ model: { provider: "openai", id: "gpt-image-2" }, resolution: "2K", aspectRatio: "16:9", prompt: "a cat" }));
    const node = applyRememberedSettings(imageNode(), settings, catalogs);
    expect(node.data).toMatchObject({ model: { provider: "openai", id: "gpt-image-2" }, resolution: "2K", aspectRatio: "16:9", prompt: "" });
  });

  it("falls back to an option the remembered model offers", () => {
    const settings = nodeGenerationSettings(imageNode({ model: { provider: "openai", id: "gpt-image-2" }, resolution: "4K", aspectRatio: "21:9" }));
    expect(applyRememberedSettings(imageNode(), settings, catalogs).data).toMatchObject({ resolution: "1K", aspectRatio: "1:1" });
  });

  it("keeps the defaults when the remembered model is no longer offered", () => {
    const settings = nodeGenerationSettings(imageNode({ model: { provider: "gemini", id: "nano-banana" } }));
    const node = imageNode();
    expect(applyRememberedSettings(node, settings, catalogs)).toBe(node);
  });

  it("uses the configured image default ahead of the remembered provider and keeps compatible options", () => {
    const settings = nodeGenerationSettings(imageNode({ resolution: "2K", aspectRatio: "16:9" }));
    const defaultImageModel = { provider: "openai", id: "gpt-image-2" };
    const selectedCatalog = { ...catalogs, defaultImageModel };
    expect(applyRememberedSettings(imageNode(), settings, selectedCatalog).data).toMatchObject({ model: defaultImageModel, resolution: "2K", aspectRatio: "16:9" });
    expect(applyRememberedSettings(imageNode(), undefined, selectedCatalog).data.model).toEqual(defaultImageModel);
  });

  it("keeps an unavailable image default visible instead of choosing another provider", () => {
    const defaultImageModel = { provider: "disabled-relay", id: "gpt-image-2" };
    expect(applyRememberedSettings(imageNode(), undefined, { ...catalogs, defaultImageModel }).data.model).toEqual(defaultImageModel);
  });

  it("carries video settings the model supports", () => {
    const base: FlowNode = { id: "video-1", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
    const settings = nodeGenerationSettings({ type: "video", data: { videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", videoAspectRatio: "1:1", duration: 10 } });
    expect(applyRememberedSettings(base, settings, catalogs).data).toMatchObject({ videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", videoAspectRatio: "16:9", duration: 10 });
  });

  it("starts new video nodes with the configured default and retains unavailable selections", () => {
    const base: FlowNode = { id: "video-1", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
    const customVideo: VideoModel = { ...video, provider: "custom-studio", id: "video-alias", referenceModes: ["frame"], imageReferenceMode: "frame" };
    const defaultVideoModel = { provider: customVideo.provider, id: customVideo.id };
    const settings = nodeGenerationSettings({ type: "video", data: { videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", duration: 10 } });
    expect(applyRememberedSettings(base, settings, { ...catalogs, videoModels: [video, customVideo], defaultVideoModel }).data).toMatchObject({
      videoModel: defaultVideoModel, videoResolution: "1080p", duration: 10, referenceMode: "frame",
    });
    expect(applyRememberedSettings(base, undefined, { ...catalogs, defaultVideoModel }).data.videoModel).toEqual(defaultVideoModel);
  });

  it("uses custom 3D defaults and face count ranges when creating nodes", () => {
    const base: FlowNode = { id: "3d-1", type: "model-3d", position: { x: 0, y: 0 }, data: { images: [] } };
    const customModel: Model3DModel = { provider: "custom-studio", providerName: "Studio", id: "mesh-alias", name: "Mesh alias", maxReferenceImages: 4,
      polycount: { min: 20_000, max: 200_000, default: 75_000, presets: [75_000, 150_000] }, supportsTexture: false, supportsPbr: false };
    const defaultModel3D = { provider: customModel.provider, id: customModel.id };
    const selectedCatalog = { ...catalogs, model3DModels: [customModel], defaultModel3D };
    expect(applyRememberedSettings(base, undefined, selectedCatalog).data.model3DConfig).toEqual({ model: defaultModel3D, targetPolycount: 75_000, texture: false, pbr: false });
    const remembered = nodeGenerationSettings({ type: "model-3d", data: { model3DConfig: { model: { provider: "meshy", id: "meshy-7.1" }, targetPolycount: 100_000, texture: true, pbr: true } } });
    expect(applyRememberedSettings(base, remembered, selectedCatalog).data.model3DConfig).toEqual({ model: defaultModel3D, targetPolycount: 100_000, texture: false, pbr: false });
    expect(applyRememberedSettings(base, remembered, { ...catalogs, model3DModels: [] }).data.model3DConfig?.model).toEqual({ provider: "meshy", id: "meshy-7.1" });
    expect(applyRememberedSettings(base, undefined, { ...catalogs, model3DModels: [], defaultModel3D }).data.model3DConfig?.model).toEqual(defaultModel3D);
  });

  it("carries a text model only while it remains available", () => {
    const model = { provider: "openai", id: "gpt-test", name: "GPT Test", providerName: "OpenAI", reasoningLevels: [] };
    const base: FlowNode = { id: "text-1", type: "text", position: { x: 0, y: 0 }, data: { text: "", instruction: "" } };
    const settings = nodeGenerationSettings({ type: "text", data: { textModel: model } });
    expect(applyRememberedSettings(base, settings, { ...catalogs, textModels: [model] }).data.textModel).toEqual({ provider: model.provider, id: model.id });
    expect(applyRememberedSettings(base, settings, catalogs)).toBe(base);
  });
});
