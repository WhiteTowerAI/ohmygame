import {
  MODEL_3D_MODELS,
  MODEL_3D_POSES,
  MODEL_3D_QUALITIES,
  MODEL_3D_TEXTURE_RESOLUTIONS,
  VIDEO_MODEL,
  type Model3DGenerationConfig,
  type PromptImage,
  type Run3DToolRequest,
} from "./contracts.js";

export const DEFAULT_IMAGE_NODE_CONFIG = { resolution: "1K", aspectRatio: "1:1" } as const;
export const DEFAULT_VIDEO_NODE_CONFIG = { model: VIDEO_MODEL, resolution: "720p", aspectRatio: "adaptive", duration: 6 } as const;

export const DEFAULT_MODEL_3D_CONFIG: Model3DGenerationConfig = {
  model: "meshy-7",
  source: "text",
  quality: "standard",
  texture: true,
  textureResolution: "2K",
  pbr: false,
  pose: "auto",
};

export function normalizeModel3DConfig(value: Partial<Model3DGenerationConfig> | undefined): Model3DGenerationConfig {
  const model = value?.model && MODEL_3D_MODELS.includes(value.model) ? value.model : DEFAULT_MODEL_3D_CONFIG.model;
  const isMeshyT2 = model === "meshy-t2";
  const source = isMeshyT2 ? "image" : value?.source === "image" ? "image" : "text";
  const texture = value?.texture ?? true;
  return {
    model,
    source,
    ...(isMeshyT2 ? {} : { quality: value?.quality && MODEL_3D_QUALITIES.includes(value.quality) ? value.quality : "standard" }),
    ...(isMeshyT2 ? { targetPolycount: validPolycount(value?.targetPolycount) ? value.targetPolycount : 4_000 } : {}),
    texture,
    textureResolution: isMeshyT2 ? "2K" : value?.textureResolution && MODEL_3D_TEXTURE_RESOLUTIONS.includes(value.textureResolution) ? value.textureResolution : "2K",
    pbr: texture ? value?.pbr ?? false : false,
    pose: isMeshyT2 ? "auto" : value?.pose && MODEL_3D_POSES.includes(value.pose) ? value.pose : "auto",
    ...(isMeshyT2 || source === "text" ? {} : { imageEnhancement: value?.imageEnhancement ?? true }),
  };
}

export function model3DReferenceLimit(config: Pick<Model3DGenerationConfig, "model">): number {
  return config.model === "meshy-t2" ? 1 : 4;
}

export function buildModel3DToolRequest(configValue: Partial<Model3DGenerationConfig>, input: { prompt: string; images: PromptImage[] }): Run3DToolRequest {
  const config = normalizeModel3DConfig(configValue);
  const options = {
    model: config.model,
    ...(config.quality ? { quality: config.quality } : {}),
    ...(config.targetPolycount !== undefined ? { targetPolycount: config.targetPolycount } : {}),
    texture: config.texture,
    ...(config.textureResolution ? { textureResolution: config.textureResolution } : {}),
    pbr: config.pbr,
    ...(config.pose ? { pose: config.pose } : {}),
  };
  if (config.source === "text") return { ...options, prompt: input.prompt.trim() };
  return {
    ...options,
    images: input.images,
    ...(config.imageEnhancement !== undefined ? { imageEnhancement: config.imageEnhancement } : {}),
  };
}

function validPolycount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 15_000;
}
