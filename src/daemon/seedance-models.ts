import type { VideoAspectRatio, VideoModel, VideoResolution } from "../shared/contracts.js";

export const SEEDANCE_PROVIDER_IDS = ["volcengine-ark", "byteplus-modelark"] as const;
export type SeedanceProviderId = (typeof SEEDANCE_PROVIDER_IDS)[number];

export interface SeedanceProviderDefinition {
  id: SeedanceProviderId;
  name: string;
  baseUrl: string;
}

export const SEEDANCE_PROVIDERS: Readonly<Record<SeedanceProviderId, SeedanceProviderDefinition>> = {
  "volcengine-ark": {
    id: "volcengine-ark",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  "byteplus-modelark": {
    id: "byteplus-modelark",
    name: "BytePlus ModelArk",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
  },
};

const ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const satisfies readonly VideoAspectRatio[];
const ADAPTIVE_ONLY = ["adaptive"] as const satisfies readonly VideoAspectRatio[];
const STANDARD_RESOLUTIONS = ["480p", "720p", "1080p"] as const satisfies readonly VideoResolution[];
const SEEDANCE_20_RESOLUTIONS = [...STANDARD_RESOLUTIONS, "4K"] as const satisfies readonly VideoResolution[];

interface SeedanceModelSpec {
  id: string;
  name: string;
  resolutions: readonly VideoResolution[];
  durations: readonly number[];
  imageAspectRatios?: readonly VideoAspectRatio[];
}

const MODEL_SPECS: Readonly<Record<SeedanceProviderId, readonly SeedanceModelSpec[]>> = {
  "volcengine-ark": [
    { id: "doubao-seedance-2-5-260628", name: "Doubao Seedance 2.5", resolutions: STANDARD_RESOLUTIONS, durations: integers(4, 30), imageAspectRatios: ADAPTIVE_ONLY },
    { id: "doubao-seedance-2-0-260128", name: "Doubao Seedance 2.0", resolutions: SEEDANCE_20_RESOLUTIONS, durations: integers(4, 15) },
  ],
  "byteplus-modelark": [
    { id: "dreamina-seedance-2-5-260628", name: "Dreamina Seedance 2.5", resolutions: STANDARD_RESOLUTIONS, durations: integers(4, 30), imageAspectRatios: ADAPTIVE_ONLY },
    { id: "dreamina-seedance-2-0-260128", name: "Dreamina Seedance 2.0", resolutions: SEEDANCE_20_RESOLUTIONS, durations: integers(4, 15) },
  ],
};

export function isSeedanceProviderId(value: string): value is SeedanceProviderId {
  return SEEDANCE_PROVIDER_IDS.includes(value as SeedanceProviderId);
}

export function seedanceModels(providerId: SeedanceProviderId): VideoModel[] {
  const provider = SEEDANCE_PROVIDERS[providerId];
  return MODEL_SPECS[providerId].map((model) => ({
    provider: provider.id,
    providerName: provider.name,
    id: model.id,
    name: model.name,
    resolutions: model.resolutions,
    aspectRatios: ASPECT_RATIOS,
    durations: model.durations,
    maxImageReferences: model.id.includes("-2-5-") ? 30 : 9,
    imageReferenceMode: "reference",
    referenceModes: ["reference", "frame"],
    ...(model.imageAspectRatios ? { frameAspectRatios: model.imageAspectRatios } : {}),
  }));
}

export function seedanceModel(providerId: SeedanceProviderId, modelId: string): VideoModel | undefined {
  return seedanceModels(providerId).find((model) => model.id === modelId);
}

function integers(first: number, last: number): readonly number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
