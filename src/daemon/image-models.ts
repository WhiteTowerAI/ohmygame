import { IMAGE_ASPECT_RATIOS, type ImageModel, type ImageResolution } from "../shared/contracts.js";

const DEFINITIONS: Record<string, Omit<ImageModel, "provider" | "providerName">> = {
  "gemini-2.5-flash-image": {
    id: "gemini-2.5-flash-image",
    name: "Nano Banana",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    generationOptions: generationOptions(["1K"]),
    supportsReferenceImage: true,
    maxOutputs: 4,
    protocol: "gemini-generate-content",
  },
  "gpt-image-2": {
    id: "gpt-image-2",
    name: "GPT Image 2",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    generationOptions: generationOptions(["1K", "2K", "4K"]),
    supportsReferenceImage: true,
    maxOutputs: 4,
    protocol: "openai-images",
  },
};

function generationOptions(resolutions: readonly ImageResolution[]) {
  return resolutions.flatMap((resolution) => IMAGE_ASPECT_RATIOS.map((aspectRatio) => ({ resolution, aspectRatio })));
}

export function imageModelDefinition(id: string): Omit<ImageModel, "provider" | "providerName"> | undefined {
  return DEFINITIONS[id];
}

export function imageModelsForProvider(
  provider: string,
  providerName: string,
  ids: readonly string[],
): ImageModel[] {
  return [...new Set(ids)].flatMap((id) => {
    const definition = imageModelDefinition(id);
    return definition ? [{ ...definition, provider, providerName }] : [];
  });
}
