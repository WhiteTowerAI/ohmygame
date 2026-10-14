import type { VideoAspectRatio, VideoModel, VideoResolution } from "../shared/contracts.js";

export const MINIMAX_PROVIDER_IDS = ["minimax-video-cn", "minimax-video-global"] as const;
export type MinimaxProviderId = (typeof MINIMAX_PROVIDER_IDS)[number];

export interface MinimaxProviderDefinition {
  id: MinimaxProviderId;
  name: string;
  baseUrl: string;
}

export const MINIMAX_PROVIDERS: Readonly<Record<MinimaxProviderId, MinimaxProviderDefinition>> = {
  "minimax-video-cn": {
    id: "minimax-video-cn",
    name: "MiniMax China",
    baseUrl: "https://api.minimax.cn",
  },
  "minimax-video-global": {
    id: "minimax-video-global",
    name: "MiniMax Global",
    baseUrl: "https://api.minimax.io",
  },
};

const ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const satisfies readonly VideoAspectRatio[];
const ADAPTIVE_ONLY = ["adaptive"] as const satisfies readonly VideoAspectRatio[];
const H3_RESOLUTIONS = ["768p", "2K"] as const satisfies readonly VideoResolution[];
const H3_MAX_RESOLUTIONS = ["480p", "768p"] as const satisfies readonly VideoResolution[];

interface MinimaxModelSpec {
  id: string;
  name: string;
  resolutions: readonly VideoResolution[];
  durations: readonly number[];
}

const MODEL_SPECS: Readonly<Record<MinimaxProviderId, readonly MinimaxModelSpec[]>> = {
  "minimax-video-cn": [
    { id: "MiniMax-H3", name: "MiniMax H3", resolutions: H3_RESOLUTIONS, durations: integers(4, 15) },
    { id: "MiniMax-H3-Max", name: "MiniMax H3 Max", resolutions: H3_MAX_RESOLUTIONS, durations: integers(5, 15) },
  ],
  "minimax-video-global": [
    { id: "MiniMax-H3", name: "MiniMax H3", resolutions: H3_RESOLUTIONS, durations: integers(4, 15) },
    { id: "MiniMax-H3-Max", name: "MiniMax H3 Max", resolutions: H3_MAX_RESOLUTIONS, durations: integers(5, 15) },
  ],
};

export function isMinimaxProviderId(value: string): value is MinimaxProviderId {
  return MINIMAX_PROVIDER_IDS.includes(value as MinimaxProviderId);
}

export function minimaxModels(providerId: MinimaxProviderId): VideoModel[] {
  const provider = MINIMAX_PROVIDERS[providerId];
  return MODEL_SPECS[providerId].map((model) => ({
    provider: provider.id,
    providerName: provider.name,
    id: model.id,
    name: model.name,
    resolutions: model.resolutions,
    aspectRatios: ASPECT_RATIOS,
    durations: model.durations,
    maxImageReferences: 9,
    imageReferenceMode: "frame",
    referenceModes: ["frame", "reference"],
    frameAspectRatios: ADAPTIVE_ONLY,
  }));
}

export function minimaxModel(providerId: MinimaxProviderId, modelId: string): VideoModel | undefined {
  return minimaxModels(providerId).find((model) => model.id === modelId);
}

function integers(first: number, last: number): readonly number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
