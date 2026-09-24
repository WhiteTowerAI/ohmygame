import { IMAGE_ASPECT_RATIOS, type ImageModel, type ImageResolution } from "../shared/contracts.js";

export const IMAGE_MODEL_IDS = ["gpt-image-2.5-flare", "gemini-3.1-flash-image"] as const;
type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

const DEFINITIONS: Record<ImageModelId, Omit<ImageModel, "provider" | "providerName">> = {
  "gpt-image-2.5-flare": {
    id: "gpt-image-2.5-flare",
    name: "GPT Image 2.5",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    generationOptions: generationOptions(["1K", "2K", "4K"]),
    supportsReferenceImage: true,
    maxOutputs: 4,
    protocol: "openai-images",
  },
  "gemini-3.1-flash-image": {
    id: "gemini-3.1-flash-image",
    name: "Nano Banana 2",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    generationOptions: generationOptions(["1K", "2K", "4K"]),
    supportsReferenceImage: true,
    maxOutputs: 4,
    protocol: "gemini-generate-content",
  },
};

function generationOptions(resolutions: readonly ImageResolution[]) {
  return resolutions.flatMap((resolution) => IMAGE_ASPECT_RATIOS.map((aspectRatio) => ({ resolution, aspectRatio })));
}

export function imageModelDefinition(id: string): Omit<ImageModel, "provider" | "providerName"> | undefined {
  return isImageModelId(id) ? DEFINITIONS[id] : undefined;
}

export function imageModelsForProvider(
  provider: string,
  providerName: string,
  ids: readonly string[],
): ImageModel[] {
  return IMAGE_MODEL_IDS
    .filter((id) => ids.includes(id))
    .map((id) => ({ ...DEFINITIONS[id], provider, providerName }));
}

function isImageModelId(id: string): id is ImageModelId {
  return (IMAGE_MODEL_IDS as readonly string[]).includes(id);
}
