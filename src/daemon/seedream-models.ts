import type { ImageAspectRatio, ImageModel, ImageResolution } from "../shared/contracts.js";

export const SEEDREAM_PROVIDER_ID = "volcengine-ark";
export const SEEDREAM_PROVIDER_NAME = "Volcengine Ark";
export const SEEDREAM_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

const ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] as const satisfies readonly ImageAspectRatio[];

interface SeedreamModelSpec {
  id: string;
  name: string;
  resolutions: readonly ImageResolution[];
  maxReferenceImages: number;
  sizes: Partial<Record<ImageResolution, Record<(typeof ASPECT_RATIOS)[number], string>>>;
  sequentialImageGeneration?: "disabled";
}

const PRO_SIZES = {
  "1K": sizes("1024x1024", "1152x864", "864x1152", "1424x800", "800x1424", "1248x832", "832x1248", "1568x672"),
  "2K": sizes("2048x2048", "2368x1776", "1776x2368", "2816x1584", "1584x2816", "2496x1664", "1664x2496", "3136x1344"),
} satisfies SeedreamModelSpec["sizes"];

const STANDARD_SIZES = {
  "2K": sizes("2048x2048", "2304x1728", "1728x2304", "2848x1600", "1600x2848", "2496x1664", "1664x2496", "3136x1344"),
  "4K": sizes("4096x4096", "4704x3520", "3520x4704", "5504x3040", "3040x5504", "4992x3328", "3328x4992", "6240x2656"),
} satisfies SeedreamModelSpec["sizes"];

const MODEL_SPECS: readonly SeedreamModelSpec[] = [
  { id: "doubao-seedream-5-0-pro-260628", name: "Doubao Seedream 5.0 Pro", resolutions: ["1K", "2K"], maxReferenceImages: 10, sizes: PRO_SIZES },
  { id: "doubao-seedream-5-0-flash-260915", name: "Doubao Seedream 5.0 Flash", resolutions: ["1K", "2K"], maxReferenceImages: 10, sizes: PRO_SIZES },
  {
    id: "doubao-seedream-5-0-260128",
    name: "Doubao Seedream 5.0",
    resolutions: ["2K", "4K"],
    maxReferenceImages: 14,
    sizes: STANDARD_SIZES,
    sequentialImageGeneration: "disabled",
  },
];

export function seedreamModels(): ImageModel[] {
  return MODEL_SPECS.map((model) => ({
    provider: SEEDREAM_PROVIDER_ID,
    providerName: SEEDREAM_PROVIDER_NAME,
    id: model.id,
    name: model.name,
    sizes: [],
    generationOptions: model.resolutions.flatMap((resolution) => ASPECT_RATIOS.map((aspectRatio) => ({ resolution, aspectRatio }))),
    supportsReferenceImage: true,
    maxReferenceImages: model.maxReferenceImages,
    maxOutputs: 1,
    protocol: "volcengine-images",
  }));
}

export function seedreamModel(modelId: string): ImageModel | undefined {
  return seedreamModels().find((model) => model.id === modelId);
}

export function seedreamRequestOptions(modelId: string, resolution: ImageResolution, aspectRatio: ImageAspectRatio): {
  size: string;
  sequentialImageGeneration?: "disabled";
} | undefined {
  const model = MODEL_SPECS.find((candidate) => candidate.id === modelId);
  const size = model?.sizes[resolution]?.[aspectRatio as (typeof ASPECT_RATIOS)[number]];
  return model && size
    ? { size, ...(model.sequentialImageGeneration ? { sequentialImageGeneration: model.sequentialImageGeneration } : {}) }
    : undefined;
}

function sizes(
  square: string,
  landscape4x3: string,
  portrait3x4: string,
  landscape16x9: string,
  portrait9x16: string,
  landscape3x2: string,
  portrait2x3: string,
  landscape21x9: string,
): Record<(typeof ASPECT_RATIOS)[number], string> {
  return {
    "1:1": square,
    "4:3": landscape4x3,
    "3:4": portrait3x4,
    "16:9": landscape16x9,
    "9:16": portrait9x16,
    "3:2": landscape3x2,
    "2:3": portrait2x3,
    "21:9": landscape21x9,
  };
}
