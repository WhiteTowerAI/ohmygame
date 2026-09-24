import { VIDEO_MODEL, type Model3DGenerationConfig, type PromptImage, type Run3DToolRequest } from "./contracts.js";

export const DEFAULT_IMAGE_NODE_CONFIG = { resolution: "1K", aspectRatio: "1:1" } as const;
export const DEFAULT_VIDEO_NODE_CONFIG = { model: VIDEO_MODEL, resolution: "720p", aspectRatio: "adaptive", duration: 6 } as const;
export const MODEL_3D_REFERENCE_LIMIT = 1;

export const DEFAULT_MODEL_3D_CONFIG: Model3DGenerationConfig = {
  targetPolycount: 4_000,
  texture: true,
  pbr: false,
};

export function normalizeModel3DConfig(value: Partial<Model3DGenerationConfig> | undefined): Model3DGenerationConfig {
  const texture = value?.texture ?? DEFAULT_MODEL_3D_CONFIG.texture;
  return {
    targetPolycount: validPolycount(value?.targetPolycount) ? value.targetPolycount : DEFAULT_MODEL_3D_CONFIG.targetPolycount,
    texture,
    pbr: texture ? value?.pbr ?? DEFAULT_MODEL_3D_CONFIG.pbr : false,
  };
}

export function buildModel3DToolRequest(configValue: Partial<Model3DGenerationConfig>, images: PromptImage[]): Run3DToolRequest {
  const config = normalizeModel3DConfig(configValue);
  return {
    images,
    targetPolycount: config.targetPolycount,
    texture: config.texture,
    pbr: config.pbr,
  };
}

function validPolycount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 15_000;
}
