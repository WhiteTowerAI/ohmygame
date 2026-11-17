import { AUDIO_KINDS, type AudioGenerationRequest, type AudioKind, type AudioModel, type AudioModelCatalog } from "../shared/audio.js";
import { preferredImageOption } from "../shared/asset-canvas.js";
import type { ImageAspectRatio, ImageModel, ImageResolution, MediaModelCatalog, ModelRef, ProjectState, VideoModel } from "../shared/contracts.js";
import { selectAudioModel } from "./audio-generation.js";

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
  return models.find((model) => model.provider === ref.provider && model.id === ref.id);
}

export function preferredMediaModelRef(projectDefault?: ModelRef, globalDefault?: ModelRef, fallback?: ModelRef): ModelRef | undefined {
  const model = projectDefault ?? globalDefault ?? fallback;
  return model && mediaModelRef(model);
}

function imageDimensions(model: ImageModel) {
  return {
    resolution: model.protocol !== "codex-cli" && model.supportsResolution !== false,
    aspectRatio: model.protocol !== "codex-cli" && model.supportsAspectRatio !== false,
  };
}

function imageOptions(model: ImageModel) {
  const dimensions = imageDimensions(model);
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

function chooseAgentImageDimensions(model: ImageModel, input: { resolution?: ImageResolution; aspectRatio?: ImageAspectRatio }) {
  const { resolution, aspectRatio } = input;
  const dimensions = imageDimensions(model);
  const supported = model.generationOptions.filter((option) =>
    (!resolution || option.resolution === resolution) && (!aspectRatio || option.aspectRatio === aspectRatio));
  if ((!resolution || dimensions.resolution) && (!aspectRatio || dimensions.aspectRatio) && supported.length) {
    return preferredImageOption({ ...model, generationOptions: supported }, aspectRatio)!;
  }
  throw new Error(`The selected image model cannot use those dimensions. Supported dimensions: ${JSON.stringify(imageOptions(model))}. Call ${MEDIA_MODEL_QUERY} to find a compatible model.`);
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

type Selection<T extends ModelRef> = { models: T[]; effective?: T; unavailable?: ModelRef; discoveryDeferred?: boolean; audioCatalog?: AudioModelCatalog };
type Readers = {
  image?: (signal?: AbortSignal, options?: { discoverLegacy?: boolean }) => Promise<MediaModelCatalog<ImageModel> & { legacyDiscoveryDeferred?: boolean }>;
  audio?: () => Promise<AudioModelCatalog>;
  video?: (signal?: AbortSignal) => Promise<MediaModelCatalog<VideoModel>>;
  configuredDefault?: (media: "image" | "video") => ModelRef | undefined;
};

export class AgentMediaModels {
  constructor(private readonly readers: Readers, private readonly defaults: () => ProjectDefaults) {}

  async #selection<K extends MediaKind>(media: K, kind?: AudioKind, signal?: AbortSignal, automatic?: boolean): Promise<Selection<Models[K]>>;
  async #selection(media: MediaKind, kind?: AudioKind, signal?: AbortSignal, automatic = false): Promise<Selection<Models[MediaKind]>> {
    const defaults = this.defaults();
    if (media === "audio") {
      const audioCatalog = await this.readers.audio?.();
      if (!audioCatalog) return { models: [] };
      return {
        audioCatalog,
        models: audioCatalog.models.filter((model) => kind ? model.capabilities.produces.includes(kind) : model.capabilities.produces.length > 0),
        effective: selectAudioModel(audioCatalog, undefined, kind, defaults),
      };
    }
    const catalog = media === "image"
      ? await this.readers.image?.(signal, { discoverLegacy: !automatic })
      : await this.readers.video?.(signal);
    const models = catalog?.models ?? [];
    const configured = preferredMediaModelRef(defaults?.[media], catalog?.defaultModel);
    const discoveryDeferred = catalog && "legacyDiscoveryDeferred" in catalog && catalog.legacyDiscoveryDeferred === true;
    const ref = configured ?? (discoveryDeferred ? undefined : models[0]);
    const effective = ref && matchingModel<ImageModel | VideoModel>(models, ref);
    return { models, effective, unavailable: effective ? undefined : ref, discoveryDeferred };
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
      effective: effective ? describeModel(effective, audioCatalog) : unavailable ? { ...unavailable, unavailable: true } : null,
      ...(options.model ? { model: model ? describeModel(model, audioCatalog) : null } : {}),
      ...(list ? {
        models: matches.slice(offset, offset + PAGE_SIZE).map((candidate) => describeModel(candidate, audioCatalog)),
        ...(matches.length > offset + PAGE_SIZE ? { nextOffset: offset + PAGE_SIZE } : {}),
      } : {}),
    };
  }

  async context() {
    // A remote provider's model list must not delay a regular chat turn indefinitely.
    const signal = AbortSignal.timeout(900);
    const bounded = <T>(work: Promise<T>) => new Promise<T | undefined>((resolve) => {
      const expired = () => resolve(undefined);
      signal.addEventListener("abort", expired, { once: true });
      void work.then(resolve, expired).finally(() => signal.removeEventListener("abort", expired));
    });
    const defaults = this.defaults();
    const [image, audio, video] = await Promise.all([
      // Legacy custom image discovery can probe chat endpoints and migrate settings.
      // Only explicit catalog requests should trigger it.
      bounded(this.#selection("image", undefined, signal, true)),
      bounded(this.readers.audio?.().then((catalog) => Object.fromEntries(AUDIO_KINDS.map((kind) => {
        const model = selectAudioModel(catalog, undefined, kind, defaults);
        return [kind, model ? describeModel(model, catalog) : null];
      }))) ?? Promise.resolve(undefined)),
      bounded(this.#selection("video", undefined, signal, true)),
    ]);
    const deferred = (media: "image" | "video") => ({
      configuredModel: preferredMediaModelRef(defaults?.[media], this.readers.configuredDefault?.(media)),
      lookupDeferred: true,
    });
    return {
      image: image?.effective ? describeModel(image.effective) : image?.unavailable || image?.discoveryDeferred || !image ? deferred("image") : null,
      audio: audio ?? { lookupDeferred: true },
      video: video?.effective ? describeModel(video.effective) : video?.unavailable || !video ? deferred("video") : null,
    };
  }

  async imageDimensions(input: { imageModel?: ModelRef; resolution?: ImageResolution; aspectRatio?: ImageAspectRatio }, signal?: AbortSignal) {
    if (!this.readers.image) return input.resolution && input.aspectRatio
      ? { resolution: input.resolution, aspectRatio: input.aspectRatio, imageModel: input.imageModel } : undefined;
    const selection = await this.#selection("image", undefined, signal);
    const model = input.imageModel ? matchingModel(selection.models, input.imageModel) : selection.effective;
    if (!model) throw new Error(`The selected image model is unavailable. Call ${MEDIA_MODEL_QUERY} to see connected image models.`);
    const { resolution, aspectRatio } = chooseAgentImageDimensions(model, input);
    return { imageModel: mediaModelRef(model), resolution, aspectRatio };
  }

  async audioModel(input: AudioGenerationRequest) {
    const format = input.output?.format;
    if (!this.readers.audio || !format) return input.model;
    const catalog = await this.readers.audio();
    const model = selectAudioModel(catalog, input.model, input.kind, this.defaults());
    if (!model) return input.model;
    if (!model.capabilities.formats.includes(format)) {
      throw new Error(`The selected audio model does not support ${format}. Supported formats: ${model.capabilities.formats.join(", ") || "provider default"}. Omit output.format to use the model default, or call ${MEDIA_MODEL_QUERY} to find another model.`);
    }
    return mediaModelRef(model);
  }
}
