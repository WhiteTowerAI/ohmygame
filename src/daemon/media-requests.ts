import { preferredImageOption } from "../shared/asset-canvas.js";
import type { ImageAspectRatio, ImageModel, ImageResolution, MediaModelCatalog, ModelRef, RunImageToolRequest, RunVideoToolRequest, VideoModel } from "../shared/contracts.js";
import { videoReferenceAspectRatios } from "../shared/video-references.js";
import { defaultSeedanceReferenceMode, isSeedanceProviderId } from "./seedance-models.js";
import { ToolRunError } from "./tools.js";

type Models = { image: ImageModel; video: VideoModel };
export type GenerationMedia = keyof Models;
export type MediaCatalogReaders = { [K in GenerationMedia]?: (signal?: AbortSignal) => Promise<MediaModelCatalog<Models[K]>> };

export function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/** A request's own model, else the project's default, else the global default. Callers then fall back to the first connected model. */
export function preferredModel(explicit?: ModelRef, projectDefault?: ModelRef, globalDefault?: ModelRef): ModelRef | undefined {
  return explicit ?? projectDefault ?? globalDefault;
}

/** Codex and some plugin workflows choose their own dimensions; the provider drops what they don't take. */
export function imageDimensionSupport(model: ImageModel): { resolution: boolean; aspectRatio: boolean } {
  return {
    resolution: model.protocol !== "codex-cli" && model.supportsResolution !== false,
    aspectRatio: model.protocol !== "codex-cli" && model.supportsAspectRatio !== false,
  };
}

/** Readable list such as `1K (1:1, 3:2); 2K (9:16)`, for errors people and agents both read. */
export function supportedImageDimensions(model: ImageModel): string {
  const byResolution = new Map<ImageResolution, ImageAspectRatio[]>();
  for (const { resolution, aspectRatio } of model.generationOptions) {
    const ratios = byResolution.get(resolution) ?? [];
    if (!ratios.includes(aspectRatio)) ratios.push(aspectRatio);
    byResolution.set(resolution, ratios);
  }
  return [...byResolution].map(([resolution, ratios]) => `${resolution} (${ratios.join(", ")})`).join("; ") || "none";
}

/**
 * Picks the dimension a request left out, so an aspect ratio or a resolution alone is enough.
 * A value the model takes but can't pair with any option is refused before anything is submitted.
 */
export function completeImageDimensions(model: ImageModel, input: { resolution?: ImageResolution; aspectRatio?: ImageAspectRatio }) {
  const support = imageDimensionSupport(model);
  const { resolution, aspectRatio } = input;
  const options = model.generationOptions.filter((option) =>
    (!resolution || !support.resolution || option.resolution === resolution) && (!aspectRatio || !support.aspectRatio || option.aspectRatio === aspectRatio));
  const chosen = options.length ? preferredImageOption({ ...model, generationOptions: options }, aspectRatio) : undefined;
  if (!chosen) throw new ToolRunError(`The selected image model cannot use those dimensions. Supported dimensions: ${supportedImageDimensions(model)}.`, 400);
  return { resolution: resolution ?? chosen.resolution, aspectRatio: aspectRatio ?? chosen.aspectRatio };
}

/** Fills a video request's duration, resolution and aspect ratio from what its model and reference mode accept. */
export function completeVideoOptions(model: VideoModel, input: RunVideoToolRequest): RunVideoToolRequest {
  // Requests without a mode used first/last frames before canvas nodes could store a mode.
  const referenceMode = input.referenceMode ?? (isSeedanceProviderId(model.provider) ? defaultSeedanceReferenceMode(model) : model.imageReferenceMode);
  const aspectRatios = videoReferenceAspectRatios(model, input.references?.length ?? 0, referenceMode);
  return {
    ...input,
    duration: input.duration ?? model.durations[0],
    resolution: input.resolution ?? model.resolutions[0],
    aspectRatio: input.aspectRatio ?? aspectRatios[0],
  };
}

/**
 * The one place that decides which image or video model a generation uses and fills the options it
 * left out. Generation, canvas nodes, the HTTP route and `inspect_media_models` all go through it.
 */
export class MediaRequests {
  /** `globalDefault` reads settings without loading a catalog; without it, the catalog's reported default applies. */
  constructor(private readonly catalogs: MediaCatalogReaders, private readonly globalDefault?: (media: GenerationMedia) => ModelRef | undefined) {}

  /** The model a request that names none would use, with every connected model. */
  async effective<K extends GenerationMedia>(media: K, projectDefault?: ModelRef, signal?: AbortSignal): Promise<{ models: Models[K][]; ref?: ModelRef; model?: Models[K] }> {
    const catalog = await this.catalogs[media]?.(signal);
    const models = [...catalog?.models ?? []] as Models[K][];
    const ref = preferredModel(undefined, projectDefault, this.globalDefault?.(media) ?? catalog?.defaultModel) ?? models[0];
    return { models, ref, model: ref && models.find((model) => sameModel(model, ref)) };
  }

  /** Undefined when no image model is chosen or connected. */
  async image(input: RunImageToolRequest, projectDefault?: ModelRef, signal?: AbortSignal): Promise<RunImageToolRequest | undefined> {
    const partial = input.size === undefined && (input.resolution === undefined) !== (input.aspectRatio === undefined);
    let ref = preferredModel(input.imageModel, projectDefault, this.globalDefault?.("image"));
    let models: readonly ImageModel[] | undefined;
    if (!ref || partial) {
      const catalog = await this.catalogs.image?.(signal);
      models = catalog?.models ?? [];
      ref ??= catalog?.defaultModel ?? models[0];
    }
    if (!ref) return undefined;
    const request: RunImageToolRequest = { ...input, imageModel: { ...ref } };
    const model = partial ? models?.find((candidate) => sameModel(candidate, ref)) : undefined;
    if (!model) return request;
    const support = imageDimensionSupport(model);
    if (!support.resolution && !support.aspectRatio) {
      const { resolution: _resolution, aspectRatio: _aspectRatio, ...rest } = request;
      return rest as RunImageToolRequest;
    }
    return { ...request, ...completeImageDimensions(model, input) } as RunImageToolRequest;
  }

  /** Undefined when no video model is chosen or connected. */
  async video(input: RunVideoToolRequest, projectDefault?: ModelRef, signal?: AbortSignal): Promise<RunVideoToolRequest | undefined> {
    const catalog = await this.catalogs.video?.(signal);
    const ref = preferredModel(input.model, projectDefault, this.globalDefault?.("video") ?? catalog?.defaultModel) ?? catalog?.models[0];
    if (!ref) return undefined;
    const model = catalog?.models.find((candidate) => sameModel(candidate, ref));
    return model ? completeVideoOptions(model, { ...input, model: ref }) : { ...input, model: { ...ref } };
  }
}
