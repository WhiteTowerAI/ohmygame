import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageModel,
  type ImageOutputCount,
  type ImageResolution,
  type VideoAspectRatio,
  type VideoModel,
  type VideoResolution,
} from "../shared/contracts.js";
import { withOpenRouterAttribution } from "./openrouter-attribution.js";

export interface OpenRouterMediaSource {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

interface CapabilityDescriptor {
  type?: unknown;
  values?: unknown;
  min?: unknown;
  max?: unknown;
}

interface OpenRouterImageRecord {
  id?: unknown;
  name?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  supported_parameters?: Record<string, CapabilityDescriptor>;
}

interface OpenRouterVideoRecord {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  supported_resolutions?: unknown;
  supported_aspect_ratios?: unknown;
  supported_durations?: unknown;
  supported_frame_images?: unknown;
}

const PREFERRED_IMAGE_MODELS = [
  "openai/gpt-image-2.5-flare",
  "google/gemini-3.1-flash-image",
  "bytedance-seed/seedream-5-0-lite",
];

const PREFERRED_VIDEO_MODELS = [
  "bytedance/seedance-2.0-mini",
  "bytedance/seedance-2.5",
  "google/veo-3.1",
];

export async function resolveOpenRouterMediaSource(runtime: ModelRuntime, signal?: AbortSignal): Promise<OpenRouterMediaSource | undefined> {
  const provider = runtime.getProvider("openrouter");
  if (!provider || !runtime.hasConfiguredAuth("openrouter")) return undefined;
  const resolution = await runtime.getAuth("openrouter", { signal });
  const apiKey = resolution?.auth.apiKey;
  if (!apiKey) return undefined;
  const configuredHeaders = resolution.auth.headers ?? {};
  return {
    baseUrl: (resolution.auth.baseUrl ?? provider.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    apiKey,
    headers: Object.fromEntries(Object.entries(configuredHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

export async function listOpenRouterImageModels(source: OpenRouterMediaSource, request: typeof fetch = fetch, signal?: AbortSignal): Promise<ImageModel[]> {
  const body = await getCatalog<{ data?: OpenRouterImageRecord[] }>(source, "/images/models", request, signal);
  return (body.data ?? []).flatMap((record) => imageModel(record)).sort(preferredOrder(PREFERRED_IMAGE_MODELS));
}

/**
 * OpenRouter's image catalog is public. Its per-model parameters describe what
 * OpenAI and Google image models accept even when they are reached directly.
 */
export async function listPublicOpenRouterImageModels(request: typeof fetch = fetch, signal?: AbortSignal): Promise<ImageModel[]> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await request("https://openrouter.ai/api/v1/images/models", {
    headers: withOpenRouterAttribution({}),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`OpenRouter model request failed (${response.status})`);
  const body = await response.json() as { data?: OpenRouterImageRecord[] };
  return (body.data ?? []).flatMap((record) => imageModel(record));
}

export async function listOpenRouterVideoModels(source: OpenRouterMediaSource, request: typeof fetch = fetch, signal?: AbortSignal): Promise<VideoModel[]> {
  const body = await getCatalog<{ data?: OpenRouterVideoRecord[] }>(source, "/videos/models", request, signal);
  return (body.data ?? []).flatMap((record) => videoModel(record)).sort(preferredOrder(PREFERRED_VIDEO_MODELS));
}

export function openRouterHeaders(source: OpenRouterMediaSource, json = false): Record<string, string> {
  return {
    ...withOpenRouterAttribution(source.headers),
    authorization: `Bearer ${source.apiKey}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function imageModel(record: OpenRouterImageRecord): ImageModel[] {
  const id = string(record.id);
  if (!id || !stringArray(record.architecture?.output_modalities).includes("image")) return [];
  const parameters = record.supported_parameters ?? {};
  const resolutionValues = enumValues(parameters.resolution);
  const aspectRatioValues = enumValues(parameters.aspect_ratio);
  const resolutions = supportedValues(resolutionValues, IMAGE_RESOLUTIONS);
  const aspectRatios = supportedValues(aspectRatioValues, IMAGE_ASPECT_RATIOS);
  if ((resolutionValues && resolutions.length === 0) || (aspectRatioValues && aspectRatios.length === 0)) return [];
  const supportsResolution = Boolean(resolutionValues);
  const supportsAspectRatio = Boolean(aspectRatioValues);
  const usableResolutions: readonly ImageResolution[] = resolutions.length ? resolutions : ["1K"];
  const usableAspectRatios: readonly ImageAspectRatio[] = aspectRatios.length ? aspectRatios : ["1:1"];
  const inputReferences = rangeMax(parameters.input_references);
  const supportsImageInput = stringArray(record.architecture?.input_modalities).includes("image");
  const maxReferenceImages = inputReferences ?? (supportsImageInput ? 1 : 0);
  const outputMax = Math.max(1, Math.min(4, rangeMax(parameters.n) ?? 1));
  const maxOutputs = [...IMAGE_OUTPUT_COUNTS].reverse().find((count) => count <= outputMax) ?? 1;
  return [{
    provider: "openrouter",
    providerName: "OpenRouter",
    id,
    name: string(record.name) ?? id,
    sizes: IMAGE_SIZES,
    generationOptions: usableResolutions.flatMap((resolution) => usableAspectRatios.map((aspectRatio) => ({ resolution, aspectRatio }))),
    supportsReferenceImage: maxReferenceImages > 0,
    maxReferenceImages,
    maxOutputs: maxOutputs as ImageOutputCount,
    protocol: "openrouter-images",
    supportsResolution,
    supportsAspectRatio,
  }];
}

function videoModel(record: OpenRouterVideoRecord): VideoModel[] {
  const id = string(record.id);
  if (!id) return [];
  const resolutions = supportedValues(stringArray(record.supported_resolutions), VIDEO_RESOLUTIONS);
  const aspectRatios = supportedValues(stringArray(record.supported_aspect_ratios), VIDEO_ASPECT_RATIOS);
  const durations = numberArray(record.supported_durations).filter((duration) => Number.isInteger(duration) && duration >= 1 && duration <= 30);
  if (!resolutions.length || !aspectRatios.length || !durations.length) return [];
  const frameImages = stringArray(record.supported_frame_images);
  const supportsReferences = /reference|image-to-video/i.test(string(record.description) ?? "");
  const maxImageReferences = supportsReferences ? 9 : Math.min(2, frameImages.length);
  return [{
    provider: "openrouter",
    providerName: "OpenRouter",
    id,
    name: string(record.name) ?? id,
    resolutions,
    aspectRatios,
    durations,
    maxImageReferences,
    ...(maxImageReferences ? { imageReferenceMode: supportsReferences ? "reference" as const : "frame" as const } : {}),
  }];
}

async function getCatalog<T>(source: OpenRouterMediaSource, path: string, request: typeof fetch, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await request(`${source.baseUrl}${path}`, {
    headers: openRouterHeaders(source),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`OpenRouter model request failed (${response.status})`);
  return await response.json() as T;
}

function enumValues(descriptor: CapabilityDescriptor | undefined): string[] | undefined {
  return descriptor?.type === "enum" && Array.isArray(descriptor.values) ? stringArray(descriptor.values) : undefined;
}

function rangeMax(descriptor: CapabilityDescriptor | undefined): number | undefined {
  return descriptor?.type === "range" && typeof descriptor.max === "number" ? descriptor.max : undefined;
}

function supportedValues<const Values extends readonly string[]>(values: readonly string[] | undefined, supported: Values): Array<Values[number]> {
  return values?.flatMap((value) => (supported as readonly string[]).includes(value) ? [value as Values[number]] : []) ?? [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item] : []) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "number" ? [item] : []) : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preferredOrder(preferred: readonly string[]) {
  return <T extends { id: string; name: string }>(left: T, right: T): number => {
    const leftIndex = preferred.indexOf(left.id);
    const rightIndex = preferred.indexOf(right.id);
    if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? preferred.length : leftIndex) - (rightIndex === -1 ? preferred.length : rightIndex);
    return left.name.localeCompare(right.name);
  };
}
