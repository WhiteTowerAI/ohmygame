import { IMAGE_ASPECT_RATIOS, type ImageAspectRatio, type ImageModel, type ImageOutputCount, type ImageProtocol, type ImageResolution } from "../shared/contracts.js";

type ImageModelDefinition = Omit<ImageModel, "provider" | "providerName">;

/**
 * Model IDs a provider's `/models` list may contain that OhMyGame can drive, by family.
 * `/models` gives IDs only, so the family decides the protocol and safe defaults, and the
 * public OpenRouter catalog (`vendor/<id>`) refines them when it knows the model.
 */
interface ImageModelFamily {
  pattern: RegExp;
  protocol: ImageProtocol;
  /** OpenRouter's vendor prefix for this family's catalog entries. */
  vendor: "openai" | "google";
  resolutions: readonly ImageResolution[];
  aspectRatios: readonly ImageAspectRatio[];
}

const FAMILIES: readonly ImageModelFamily[] = [
  // GPT Image 1 only renders three fixed sizes.
  { pattern: /^gpt-image-1(?:-|$)/, protocol: "openai-images", vendor: "openai", resolutions: ["1K"], aspectRatios: ["1:1", "3:2", "2:3"] },
  { pattern: /^gpt-image-/, protocol: "openai-images", vendor: "openai", resolutions: ["1K", "2K", "4K"], aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] },
  // OpenAI-compatible relays that also serve Gemini image models.
  { pattern: /^gemini-[\w.-]*-image(?:-|$)/, protocol: "gemini-generate-content", vendor: "google", resolutions: ["1K"], aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"] },
];

/** Listed first, and used when no model is requested. */
const PREFERRED_IDS = ["gpt-image-2.5-flare", "gemini-3.1-flash-image"];

/** Image models a provider offers, from its `/models` IDs and the public catalog's capabilities. */
export function imageModelsForProvider(
  provider: string,
  providerName: string,
  ids: readonly string[],
  catalog: readonly ImageModel[] = [],
): ImageModel[] {
  const definitions = ids.flatMap((id) => {
    const definition = imageModelDefinition(id, catalog);
    return definition ? [{ ...definition, provider, providerName }] : [];
  });
  return definitions.sort((left, right) => rank(left.id) - rank(right.id) || left.id.localeCompare(right.id));
}

export function imageModelDefinition(id: string, catalog: readonly ImageModel[] = []): ImageModelDefinition | undefined {
  const family = FAMILIES.find((candidate) => candidate.pattern.test(id));
  if (!family) return undefined;
  const known = catalog.find((model) => model.id === `${family.vendor}/${id}`);
  const knownRatios = unique(known?.generationOptions.map((option) => option.aspectRatio) ?? []);
  const knownResolutions = known?.supportsResolution ? unique(known.generationOptions.map((option) => option.resolution)) : [];
  // OpenAI takes a pixel size, which OhMyGame derives for its own resolutions, so the catalog only narrows ratios.
  const resolutions = family.protocol === "gemini-generate-content" && knownResolutions.length ? knownResolutions : family.resolutions;
  const aspectRatios = knownRatios.length ? IMAGE_ASPECT_RATIOS.filter((ratio) => knownRatios.includes(ratio) && (family.protocol !== "openai-images" || family.aspectRatios.includes(ratio))) : family.aspectRatios;
  return {
    id,
    name: known ? known.name.replace(/^[^:]{1,40}:\s+/, "") : displayName(id),
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    generationOptions: resolutions.flatMap((resolution) => aspectRatios.map((aspectRatio) => ({ resolution, aspectRatio }))),
    supportsReferenceImage: known ? known.supportsReferenceImage : true,
    ...(known?.maxReferenceImages ? { maxReferenceImages: known.maxReferenceImages } : {}),
    maxOutputs: known?.maxOutputs ?? (1 satisfies ImageOutputCount),
    protocol: family.protocol,
  };
}

export function preferredImageModelId(ids: readonly string[]): string | undefined {
  return [...ids].filter((id) => FAMILIES.some((family) => family.pattern.test(id))).sort((left, right) => rank(left) - rank(right))[0];
}

function rank(id: string): number {
  const index = PREFERRED_IDS.indexOf(id);
  return index === -1 ? PREFERRED_IDS.length : index;
}

/** "gpt-image-2.5-flare" → "GPT Image 2.5 Flare" when the catalog doesn't name it. */
function displayName(id: string): string {
  return id.split("-").map((part) => part === "gpt" ? "GPT" : /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function unique<Value>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}
