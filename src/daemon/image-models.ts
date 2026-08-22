import type { ImageModel } from "../shared/contracts.js";

const DEFINITIONS: Record<string, Omit<ImageModel, "provider" | "providerName">> = {
  "gpt-image-2": {
    id: "gpt-image-2",
    name: "GPT Image 2",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
  },
};

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
