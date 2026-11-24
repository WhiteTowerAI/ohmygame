import { type AudioGenerationRequest, type AudioKind, type AudioModel, type AudioModelCatalog } from "../shared/audio.js";
import type { ImageAspectRatio, ImageModel, ImageResolution, ModelRef, ProjectState, VideoModel } from "../shared/contracts.js";
import { ignoredAudioOptions, selectAudioModel } from "./audio-generation.js";
import { ignoredImageOptions, imageDimensionSupport, sameModel, type MediaRequests } from "./media-requests.js";

type Models = {
  image: ImageModel;
  audio: AudioModel;
  video: VideoModel;
};
type MediaKind = keyof Models;
type ProjectDefaults = ProjectState["mediaModelDefaults"];

export const MEDIA_MODEL_QUERY = "inspect_media_models";
const PAGE_SIZE = 12;

function mediaModelRef(model: ModelRef): ModelRef {
  return { provider: model.provider, id: model.id };
}

function matchingModel<T extends ModelRef>(models: readonly T[], ref: ModelRef): T | undefined {
  return models.find((model) => sameModel(model, ref));
}

function imageOptions(model: ImageModel) {
  const dimensions = imageDimensionSupport(model);
  const options: Partial<Record<ImageResolution, ImageAspectRatio[]>> = {};
  for (const { resolution, aspectRatio } of model.generationOptions) {
    const ratios = options[resolution] ??= [];
    if (!ratios.includes(aspectRatio)) ratios.push(aspectRatio);
  }
  return {
    acceptsResolution: dimensions.resolution,
    acceptsAspectRatio: dimensions.aspectRatio,
    ...(dimensions.resolution && dimensions.aspectRatio ? { aspectRatiosByResolution: options }
      : dimensions.resolution ? { resolutions: Object.keys(options) }
      : dimensions.aspectRatio ? { aspectRatios: [...new Set(Object.values(options).flat())] } : {}),
  };
}

function describeModel(model: Models[MediaKind], audioCatalog?: AudioModelCatalog) {
  const identity = { ...mediaModelRef(model), name: model.name.slice(0, 100) };
  if ("generationOptions" in model) return {
    ...identity, ...imageOptions(model),
    supportsReferenceImage: model.supportsReferenceImage,
    ...(model.minReferenceImages ? { minReferenceImages: model.minReferenceImages } : {}),
  };
  if ("durations" in model) return {
    ...identity,
    resolutions: model.resolutions, aspectRatios: model.aspectRatios, durationsSeconds: model.durations,
    maxImageReferences: model.maxImageReferences, imageReferenceMode: model.imageReferenceMode,
    imageAspectRatios: model.imageAspectRatios, frameAspectRatios: model.frameAspectRatios,
  };
  const caps = model.capabilities;
  const provider = audioCatalog?.providers.find((item) => item.provider === model.provider);
  return {
    ...identity,
    produces: caps.produces, readsText: !!caps.readsText,
    formats: caps.formats, sampleRates: caps.sampleRates, sampleRatesByFormat: caps.sampleRatesByFormat,
    requiresVoice: !!caps.requiresVoice, hasDefaultVoice: !!provider?.defaultVoiceId, listsVoices: !!provider?.listsVoices,
    speedPercentRange: caps.readsText ? caps.speedRange ?? [-50, 100] : undefined,
    supportsPitch: !!caps.supportsPitch, supportsVolume: !!caps.supportsVolume, supportsStyle: !!caps.supportsStyle,
    supportsSSML: !!caps.supportsSSML, supportsSpeechOptions: !!caps.supportsSpeechOptions,
    supportsLoop: !!caps.supportsLoop, supportsInstrumental: !!caps.supportsInstrumental,
    minDurationSeconds: caps.minDurationSeconds, maxDurationSeconds: caps.maxDurationSeconds, maxTextCharacters: caps.maxTextCharacters,
  };
}

type Selection<T extends ModelRef> = { models: T[]; effective?: T; unavailable?: ModelRef; audioCatalog?: AudioModelCatalog };
/** Reports what generation would use: image and video selection come from the same `MediaRequests` generation resolves through. */
export class AgentMediaModels {
  constructor(
    private readonly requests: MediaRequests,
    private readonly audio: (() => Promise<AudioModelCatalog>) | undefined,
    private readonly defaults: () => ProjectDefaults,
  ) {}

  async #selection<K extends MediaKind>(media: K, kind?: AudioKind, signal?: AbortSignal): Promise<Selection<Models[K]>>;
  async #selection(media: MediaKind, kind?: AudioKind, signal?: AbortSignal): Promise<Selection<Models[MediaKind]>> {
    const defaults = this.defaults();
    if (media === "audio") {
      const audioCatalog = await this.audio?.();
      if (!audioCatalog) return { models: [] };
      return {
        audioCatalog,
        models: audioCatalog.models.filter((model) => kind ? model.capabilities.produces.includes(kind) : model.capabilities.produces.length > 0),
        effective: selectAudioModel(audioCatalog, undefined, kind, defaults),
      };
    }
    const { models, ref, model } = await this.requests.effective(media, defaults?.[media], signal);
    return { models, effective: model, unavailable: model ? undefined : ref };
  }

  async inspect(media: MediaKind, options: { kind?: AudioKind; search?: string; model?: ModelRef; alternatives?: boolean; offset?: number }, signal?: AbortSignal) {
    const { models, effective, unavailable, audioCatalog } = await this.#selection(media, options.kind, signal);
    const model = options.model && matchingModel(models, options.model);
    const search = options.search?.trim().toLowerCase();
    const list = options.alternatives || Boolean(search) || options.offset !== undefined;
    const offset = options.offset ?? 0;
    const matches = list ? models.filter((candidate) =>
      !search || [candidate.name, candidate.id, candidate.provider, candidate.providerName].some((value) => value.toLowerCase().includes(search))) : [];
    return {
      effective: effective ? describeModel(effective, audioCatalog) : unavailable ? { ...mediaModelRef(unavailable), unavailable: true } : null,
      ...(options.model ? { model: model ? describeModel(model, audioCatalog) : null } : {}),
      ...(list ? {
        models: matches.slice(offset, offset + PAGE_SIZE).map((candidate) => describeModel(candidate, audioCatalog)),
        ...(matches.length > offset + PAGE_SIZE ? { nextOffset: offset + PAGE_SIZE } : {}),
      } : {}),
    };
  }

  /** Every connected model of a kind, described as `inspect` does, and the one a request without a model uses. */
  async list(media: "image" | "audio", kind?: AudioKind, signal?: AbortSignal) {
    const { models, effective, audioCatalog } = await this.#selection(media, kind, signal);
    return {
      ...(effective ? { default: mediaModelRef(effective) } : {}),
      models: models.map((model) => describeModel(model, audioCatalog)),
    };
  }

  /** Options the model a request resolves to won't apply, found the way generation selects it. Empty when it can't tell. */
  async ignored(media: "image", request: { imageModel?: ModelRef; size?: unknown; resolution?: unknown; aspectRatio?: unknown }, signal?: AbortSignal): Promise<string[]>;
  async ignored(media: "audio", request: AudioGenerationRequest, signal?: AbortSignal): Promise<string[]>;
  async ignored(media: "image" | "audio", request: object, signal?: AbortSignal): Promise<string[]> {
    if (media === "audio") {
      const catalog = await this.audio?.();
      const audio = request as AudioGenerationRequest;
      const model = catalog && selectAudioModel(catalog, audio.model, audio.kind, this.defaults());
      return model ? ignoredAudioOptions(model, audio) : [];
    }
    const image = request as { imageModel?: ModelRef; size?: unknown; resolution?: unknown; aspectRatio?: unknown };
    if (image.size === undefined && image.resolution === undefined && image.aspectRatio === undefined) return [];
    const { models, model: effective } = await this.requests.effective("image", this.defaults()?.image, signal);
    const model = image.imageModel ? matchingModel(models, image.imageModel) : effective;
    return model ? ignoredImageOptions(model, image) : [];
  }
}
