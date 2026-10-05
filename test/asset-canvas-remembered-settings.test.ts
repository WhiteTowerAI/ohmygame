import { describe, expect, it } from "vitest";
import type { ImageModel, VideoModel } from "../src/shared/contracts.js";
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

  it("carries video settings the model supports", () => {
    const base: FlowNode = { id: "video-1", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", references: [] } };
    const settings = nodeGenerationSettings({ type: "video", data: { videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", videoAspectRatio: "1:1", duration: 10 } });
    expect(applyRememberedSettings(base, settings, catalogs).data).toMatchObject({ videoModel: { provider: "fal", id: "kling" }, videoResolution: "1080p", videoAspectRatio: "16:9", duration: 10 });
  });
});
