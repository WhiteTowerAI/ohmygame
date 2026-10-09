import { type Model3DGenerationConfig, type Model3DModel, type PromptImage, type Run3DToolRequest } from "./contracts.js";

export const DEFAULT_IMAGE_NODE_CONFIG = { resolution: "1K", aspectRatio: "1:1" } as const;
export const DEFAULT_VIDEO_NODE_CONFIG = { resolution: "720p", aspectRatio: "adaptive", duration: 6 } as const;

/** Built-in 3D models. Custom providers add their saved definitions at runtime. */
export const MODEL_3D_MODELS: readonly Model3DModel[] = [
  {
    provider: "meshy",
    id: "meshy-t2",
    name: "Meshy T2",
    providerName: "Meshy",
    maxReferenceImages: 1,
    polycount: { min: 100, max: 15_000, default: 4_000, presets: [1_000, 4_000, 10_000, 15_000] },
  },
  {
    provider: "meshy",
    id: "meshy-7.1",
    name: "Meshy 7.1",
    providerName: "Meshy",
    maxReferenceImages: 4,
    polycount: { min: 100, max: 300_000, default: 30_000, presets: [10_000, 30_000, 100_000] },
  },
];

export const DEFAULT_MODEL_3D = MODEL_3D_MODELS[0]!;
export const MODEL_3D_MAX_REFERENCE_IMAGES = Math.max(...MODEL_3D_MODELS.map((model) => model.maxReferenceImages));
export const MODEL_3D_MAX_POLYCOUNT = Math.max(...MODEL_3D_MODELS.map((model) => model.polycount.max));

/** The known 3D model a request or node names, or the default when it names none. Unknown models return undefined. */
export function resolveModel3D(model: unknown, models: readonly Model3DModel[] = MODEL_3D_MODELS): Model3DModel | undefined {
  if (model === undefined) return DEFAULT_MODEL_3D;
  if (!model || typeof model !== "object") return undefined;
  const { provider, id } = model as Record<string, unknown>;
  return models.find((candidate) => candidate.provider === provider && candidate.id === id);
}

/** Meshy rejects animation requests with more library actions than this; larger sets are split across requests. */
export const ANIMATION_ACTIONS_PER_REQUEST = 10;
/** Every request reuses one rig and the results are merged into a single GLB, so this only bounds spend per run. */
export const MAX_ANIMATION_ACTIONS = 30;
export const DEFAULT_CHARACTER_HEIGHT_METERS = 1.7;
/** A game-ready starter set from Meshy's library: Idle, Casual Walk, Run Fast, Regular Jump, Attack, Hit Reaction, Dead. */
export const DEFAULT_ANIMATION_ACTION_IDS: readonly number[] = [0, 30, 16, 466, 4, 178, 8];

export const DEFAULT_MODEL_3D_CONFIG: Model3DGenerationConfig = {
  targetPolycount: DEFAULT_MODEL_3D.polycount.default,
  texture: true,
  pbr: false,
};

export function normalizeModel3DConfig(value: Partial<Model3DGenerationConfig> | undefined): Model3DGenerationConfig {
  const texture = value?.texture ?? DEFAULT_MODEL_3D_CONFIG.texture;
  const polycount = resolveModel3D(value?.model)?.polycount ?? (value?.model
    ? { min: 100, max: MODEL_3D_MAX_POLYCOUNT, default: DEFAULT_MODEL_3D.polycount.default } : DEFAULT_MODEL_3D.polycount);
  const targetPolycount = value?.targetPolycount;
  return {
    ...(value?.model ? { model: value.model } : {}),
    targetPolycount: Number.isInteger(targetPolycount) && targetPolycount! >= polycount.min && targetPolycount! <= polycount.max ? targetPolycount! : polycount.default,
    texture,
    pbr: texture ? value?.pbr ?? DEFAULT_MODEL_3D_CONFIG.pbr : false,
  };
}

export function buildModel3DToolRequest(configValue: Partial<Model3DGenerationConfig>, images: PromptImage[]): Run3DToolRequest {
  const config = normalizeModel3DConfig(configValue);
  return {
    images,
    ...(config.model ? { model: config.model } : {}),
    targetPolycount: config.targetPolycount,
    texture: config.texture,
    pbr: config.pbr,
  };
}
