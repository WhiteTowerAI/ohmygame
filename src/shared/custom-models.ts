import {
  IMAGE_ASPECT_RATIOS, IMAGE_OUTPUT_COUNTS, IMAGE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS,
  type CustomImageModelSettings, type CustomModel3DSettings, type CustomModelUsages, type CustomProviderModel,
  type CustomProviderSettings, type CustomVideoModelSettings, type ImageModel, type ImageProtocol,
  type Model3DDefinition, type Model3DModel, type ProviderCapability, type VideoModel, type VideoProtocol,
} from "./contracts.js";
import { hyper3DCredits } from "./cloud-models.js";

export const MODEL_USAGE_LABELS: Record<ProviderCapability, string> = { language: "Language", image: "Image", video: "Video", "3d": "3D" };
export const IMAGE_PROTOCOL_LABELS: Record<ImageProtocol, string> = {
  "openai-images": "OpenAI Images", "gemini-generate-content": "Gemini Generate Content",
  "openrouter-images": "OpenRouter Images", "volcengine-images": "Seedream",
};
export const VIDEO_PROTOCOL_LABELS: Record<VideoProtocol, string> = { "openrouter-videos": "OpenRouter Videos", seedance: "Seedance" };

export function modelUsages(model: CustomProviderModel): CustomModelUsages {
  return model.usages ?? { language: true };
}
export function modelUsageList(model: CustomProviderModel): ProviderCapability[] {
  const usages = modelUsages(model);
  return (["language", "image", "video", "3d"] as const).filter((usage) => Boolean(usages[usage]));
}
export function defaultImageSettings(protocol: ImageProtocol = "openai-images"): CustomImageModelSettings {
  return { protocol, resolutions: ["1K"], aspectRatios: ["1:1", "3:2", "2:3"], maxReferenceImages: 1, maxOutputs: 1 };
}
export function defaultVideoSettings(protocol: VideoProtocol = "openrouter-videos"): CustomVideoModelSettings {
  return { protocol, resolutions: ["720p"], aspectRatios: ["16:9", "9:16", "1:1"], durations: [6], maxReferenceImages: 1, referenceModes: ["reference"] };
}
export function defaultModel3DSettings(modelType: CustomModel3DSettings["modelType"] = "standard", protocol: CustomModel3DSettings["protocol"] = "meshy"): CustomModel3DSettings {
  if (protocol === "hyper3d") return { protocol, operation: "multi-image-to-3d", modelType: "standard", maxReferenceImages: 5,
    polycount: { min: 500, max: 1_000_000, default: 4_000, presets: [1_000, 4_000, 10_000, 20_000, 100_000] }, supportsTexture: true, supportsPbr: true };
  if (protocol === "tripo") return { protocol, operation: "multi-image-to-3d", modelType: "standard", maxReferenceImages: 4,
    polycount: { min: 100, max: 20_000, default: 4_000, presets: [1_000, 4_000, 10_000, 20_000] }, supportsTexture: true, supportsPbr: true };
  if (modelType === "smart-topology") return { protocol: "meshy", operation: "image-to-3d", modelType, maxReferenceImages: 1,
    polycount: { min: 100, max: 15_000, default: 4_000, presets: [1_000, 4_000, 10_000, 15_000] }, supportsTexture: true, supportsPbr: true };
  return { protocol: "meshy", operation: "image-to-3d", modelType: "standard", maxReferenceImages: 1,
    polycount: { min: 100, max: 300_000, default: 30_000, presets: [10_000, 30_000, 100_000] }, supportsTexture: true, supportsPbr: true };
}

export function customImageModel(provider: CustomProviderSettings, model: CustomProviderModel): ImageModel | undefined {
  const config = model.usages?.image;
  return config ? { provider: provider.id, providerName: provider.name, id: model.id, name: model.name,
    protocol: config.protocol, sizes: ["1024x1024", "1536x1024", "1024x1536"],
    generationOptions: config.resolutions.flatMap((resolution) => config.aspectRatios.map((aspectRatio) => ({ resolution, aspectRatio }))),
    supportsReferenceImage: config.maxReferenceImages > 0, maxReferenceImages: config.maxReferenceImages, maxOutputs: config.maxOutputs } : undefined;
}
export function customVideoModel(provider: CustomProviderSettings, model: CustomProviderModel): VideoModel | undefined {
  const config = model.usages?.video;
  return config ? { provider: provider.id, providerName: provider.name, id: model.id, name: model.name,
    resolutions: config.resolutions, aspectRatios: config.aspectRatios, durations: config.durations,
    maxImageReferences: config.maxReferenceImages, imageReferenceMode: config.referenceModes[0]!, referenceModes: config.referenceModes } : undefined;
}
export function customModel3D(provider: CustomProviderSettings, model: CustomProviderModel): Model3DModel | undefined {
  const config = model.usages?.["3d"];
  return config ? model3DModel(provider.id, provider.name, { id: model.id, name: model.name, settings: config }) : undefined;
}
export function model3DModel(provider: string, providerName: string, model: Model3DDefinition): Model3DModel {
  const config = model.settings;
  return { provider, providerName, id: model.id, name: model.name,
    ...(config.protocol === "tripo" ? { referenceImageLabels: ["Front", "Left", "Back", "Right"] } : {}),
    ...(config.protocol === "hyper3d" ? { estimatedCredits: hyper3DCredits(model.id) } : {}),
    maxReferenceImages: config.maxReferenceImages, polycount: config.polycount, supportsTexture: config.supportsTexture,
    supportsPbr: config.supportsPbr, defaults: config.defaults ?? { texture: config.supportsTexture, pbr: false } };
}

/** Shared validation keeps saved configuration and the editor's controls in agreement. */
export function normalizeModelUsages(value: unknown): CustomModelUsages | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some((key) => !["language", "image", "video", "3d"].includes(key))) throw new Error("Invalid model uses");
  const usages: CustomModelUsages = {};
  if (value.language !== undefined) {
    if (typeof value.language !== "boolean") throw new Error("Invalid language capability");
    if (value.language) usages.language = true;
  }
  if (value.image !== undefined) {
    const config = value.image;
    if (!object(config) || !Object.hasOwn(IMAGE_PROTOCOL_LABELS, String(config.protocol))) throw new Error("Choose an image protocol");
    usages.image = { protocol: config.protocol as ImageProtocol, ...endpoint(config),
      resolutions: choices(config.resolutions, IMAGE_RESOLUTIONS.filter((value) => value !== "512" || config.protocol === "gemini-generate-content" || config.protocol === "openrouter-images"), "image resolutions"),
      aspectRatios: choices(config.aspectRatios, IMAGE_ASPECT_RATIOS, "image aspect ratios"),
      maxReferenceImages: integer(config.maxReferenceImages, 0, 14, "reference image limit"),
      maxOutputs: choices([config.maxOutputs], IMAGE_OUTPUT_COUNTS, "image output count")[0]! };
  }
  if (value.video !== undefined) {
    const config = value.video;
    if (!object(config) || !Object.hasOwn(VIDEO_PROTOCOL_LABELS, String(config.protocol))) throw new Error("Choose a video protocol");
    if (!Array.isArray(config.durations) || !config.durations.length || config.durations.length > 30) throw new Error("Choose video durations");
    const maxReferenceImages = integer(config.maxReferenceImages, 0, 30, "reference image limit");
    const referenceModes = choices(config.referenceModes, ["frame", "reference"] as const, "video reference modes");
    if (referenceModes.includes("frame") && maxReferenceImages > 2 && !referenceModes.includes("reference")) throw new Error("Frame mode accepts at most two reference images");
    usages.video = { protocol: config.protocol as VideoProtocol, ...endpoint(config),
      resolutions: choices(config.resolutions, VIDEO_RESOLUTIONS, "video resolutions"),
      aspectRatios: choices(config.aspectRatios, VIDEO_ASPECT_RATIOS, "video aspect ratios"),
      durations: [...new Set(config.durations.map((duration) => integer(duration, 1, 30, "video duration")))].sort((a, b) => a - b),
      maxReferenceImages, referenceModes };
  }
  if (value["3d"] !== undefined) {
    const config = value["3d"];
    if (!object(config) || !["meshy", "tripo", "hyper3d"].includes(String(config.protocol)) || !["image-to-3d", "multi-image-to-3d"].includes(String(config.operation)) || !["standard", "smart-topology"].includes(String(config.modelType))) throw new Error("Choose a 3D generation protocol and template");
    if (config.protocol !== "meshy" && config.modelType !== "standard") throw new Error("Smart topology is only supported by Meshy");
    if (config.modelType === "smart-topology" && config.operation !== "image-to-3d") throw new Error("Smart topology requires a single image");
    const maxReferenceImages = integer(config.maxReferenceImages, 1, config.operation === "image-to-3d" ? 1 : config.protocol === "hyper3d" ? 5 : 4, "3D reference image limit");
    if (!object(config.polycount)) throw new Error("Set the 3D polycount range");
    const limit = config.protocol === "hyper3d" ? 2_000_000 : config.protocol === "tripo" ? 1_500_000 : 300_000;
    const min = integer(config.polycount.min, config.protocol === "hyper3d" ? 500 : 100, limit, "minimum polycount");
    const max = integer(config.polycount.max, min, limit, "maximum polycount");
    const defaultCount = integer(config.polycount.default, min, max, "default polycount");
    if (!Array.isArray(config.polycount.presets) || !config.polycount.presets.length || config.polycount.presets.length > 20) throw new Error("Set polycount presets");
    const presets = [...new Set(config.polycount.presets.map((count) => integer(count, min, max, "polycount preset")))].sort((a, b) => a - b);
    if (typeof config.supportsTexture !== "boolean" || typeof config.supportsPbr !== "boolean" || (config.supportsPbr && !config.supportsTexture)) throw new Error("PBR requires texture support");
    let defaults: CustomModel3DSettings["defaults"];
    if (config.defaults !== undefined) {
      if (!object(config.defaults) || typeof config.defaults.texture !== "boolean" || typeof config.defaults.pbr !== "boolean"
        || config.defaults.texture && !config.supportsTexture || config.defaults.pbr && (!config.defaults.texture || !config.supportsPbr)) throw new Error("Generation defaults must use supported texture and PBR options");
      defaults = { texture: config.defaults.texture, pbr: config.defaults.pbr };
    }
    usages["3d"] = { protocol: config.protocol as CustomModel3DSettings["protocol"], ...endpoint(config), operation: config.operation as CustomModel3DSettings["operation"],
      modelType: config.modelType as CustomModel3DSettings["modelType"], maxReferenceImages,
      polycount: { min, max, default: defaultCount, presets }, supportsTexture: config.supportsTexture, supportsPbr: config.supportsPbr,
      ...(defaults ? { defaults } : {}) };
  }
  return usages;
}

export function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Base URL is required");
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Base URL must be an HTTP(S) URL without credentials, query or fragment");
  return value.trim().replace(/\/+$/, "");
}
function endpoint(config: Record<string, unknown>): { baseUrl?: string } {
  return config.baseUrl === undefined || config.baseUrl === "" ? {} : { baseUrl: normalizeEndpoint(config.baseUrl) };
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Check ${label} (${min}–${max})`);
  return value;
}
function choices<T extends string | number>(value: unknown, allowed: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || !value.length || value.length > allowed.length || value.some((item) => !allowed.includes(item))) throw new Error(`Choose supported ${label}`);
  return [...new Set(value)] as T[];
}
