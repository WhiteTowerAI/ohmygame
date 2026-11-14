import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AudioGenerationRequest, AudioModel, AudioOutputFormat, AudioVoice, GeneratedAudio } from "../shared/audio.js";
import type { ImageModel, Model3DModel, PromptImage, VideoModel, VideoReferenceMode } from "../shared/contracts.js";
import { videoReferenceAspectRatios } from "../shared/video-references.js";
import { AudioGenerationError, type AudioProviderAdapter } from "./audio-generation.js";
import { inspectAudio } from "./audio-media.js";
import { Model3DGenerationError, type Generated3DModel, type Model3DGenerationInput } from "./model3d.js";
import { networkCovers, PLUGIN_MEDIA_ADAPTER_MAX_BYTES, pluginMediaModelProblem, type PluginMediaKind, type PluginMediaModel, type PluginMediaModelList, type PluginMediaModels } from "../shared/plugin-manifest.js";
import { sniffImageType } from "./image-format.js";
import { GenerationShutdown, MediaTaskBusyError, type MediaTaskJournal, type MediaTaskStart } from "./media-task-journal.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput } from "./openai-image.js";
import { localizePluginString, type PluginIndexEntry } from "./plugin-index.js";
import { MediaInputFiles } from "./plugin-media-files.js";
import { PluginMediaModelChoiceError, PluginMediaModelChoices } from "./plugin-media-models.js";
import { runMediaAdapter, type MediaFetchRequest, type MediaFetchResponse } from "./plugin-media-sandbox.js";
import { pluginModelProviderId } from "./plugin-model-providers.js";
import type { PluginServices } from "./plugin-services.js";
import { VideoGenerationError, type GeneratedVideo, type VideoGenerationInput } from "./video-generation.js";

// What installed plugins' model providers make besides chat
// (docs/media-provider-plugins.md). Each provider's media models join the
// app's catalogs under the provider's id while its key is set; a request
// runs the plugin's adapter in the sandbox, which reaches the vendor only
// through `fetch` here, to the hosts the person approved, with the key added
// where the adapter asks.

type ManifestProvider = NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number];
type MediaSection = NonNullable<ManifestProvider["media"]>;
type MediaAuth = NonNullable<MediaSection["auth"]>;
/** The error a kind's requests fail with, which carries an HTTP status. */
type Failure = new (message: string, statusCode?: number) => Error;

const DEFAULT_AUTH: MediaAuth = { header: "authorization", scheme: "Bearer" };
/** One answer `host.fetch` gives, and one picture the app downloads. */
const RESPONSE_MAX_BYTES = 20 * 1024 * 1024;
/** One video the app downloads. */
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
// Synchronous image generation needs the same budget as the built-in Seedream provider.
const IMAGE_REQUEST_TIMEOUT_MS = 180_000;
/** A video download, which may be large. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ANSWER_HEADERS = ["content-type", "content-length", "retry-after", "location", "x-request-id"];
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
/** A task the adapter keeps between checks. */
const TASK_MAX_CHARACTERS = 16 * 1024;
/** How long an image may take, checks included. */
const IMAGE_LIMIT_MS = 10 * 60_000;
/** How long a video may take, checks and the download included, as for built-in providers. */
/** A video's limit when its provider doesn't set `maxMinutes`. */
const VIDEO_LIMIT_MS = 15 * 60_000;
/** An audio request's limit when its provider doesn't set `maxMinutes`. */
const AUDIO_LIMIT_MS = 10 * 60_000;
/** One audio file or 3D model the app downloads, as for built-in providers. */
const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
const MODEL3D_MAX_BYTES = 100 * 1024 * 1024;
/** A 3D request's limit when its provider doesn't set `maxMinutes`. */
const MODEL3D_LIMIT_MS = 15 * 60_000;
/** An audio failure with a status, as the other kinds' errors default to one. */
class AudioFailure extends AudioGenerationError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
  }
}
const AUDIO_MEDIA_TYPES: Record<AudioOutputFormat, GeneratedAudio["mediaType"]> = { mp3: "audio/mpeg", wav: "audio/wav", ogg_opus: "audio/ogg" };
/** How long telling the vendor to stop may take. */
const CANCEL_LIMIT_MS = 30_000;
/** Failed checks in a row tried again before a task is given up, so a network blip doesn't cost it. */
const CHECK_RETRIES = 2;
/** Listing a vendor's models may read many pages: its own running time and its time in all. */
const LIST_CPU_MS = 10_000;
const LIST_CALL_MS = 5 * 60_000;
/** The most models of a kind a provider lists. */
const LIST_MAX_MODELS = 2000;


export interface PluginMediaProvider {
  /** `plugin.<publisher>.<name>.<provider>`, as its chat is. */
  id: string;
  entry: PluginIndexEntry;
  provider: ManifestProvider;
  media: MediaSection;
}

/** Which of the files OhMyGame keeps a piece of audio is, from what inspecting it found. */
function audioFormat(audio: { codec: string; mime: string }): AudioOutputFormat | undefined {
  if (audio.codec === "mp3") return "mp3";
  if (audio.mime.includes("wav")) return "wav";
  if (audio.mime.includes("ogg") && audio.codec === "opus") return "ogg_opus";
  return undefined;
}

/** A model's `data`, given back to the adapter. */
function modelData(model: PluginMediaModel | undefined): { modelData?: Record<string, unknown> } {
  return model?.data ? { modelData: model.data } : {};
}

/** What an adapter's step answered. */
type Answer =
  | { outputs: Output[] }
  | { error: string }
  | { task: unknown; retryAfter?: number };
type Output = { url: string } | { base64: string; mediaType?: string };

interface RunOptions {
  files?: MediaInputFiles;
  limitMs: number;
  signal?: AbortSignal | undefined;
  Failure: Failure;
  /** Where a task is kept so a retry after a restart resumes it. */
  journal?: MediaTaskJournal | undefined;
}

export class PluginMediaProviders {
  readonly #sources = new Map<string, Promise<string>>();
  /** What each provider's adapter listed, by provider, kind and package, until the app closes. */
  readonly #listed = new Map<string, { models: PluginMediaModel[]; at: string; skipped: number }>();

  constructor(
    private readonly services: PluginServices,
    private readonly request: typeof fetch = fetch,
    private readonly log: (pluginId: string, message: string) => void = () => {},
    private readonly choices = new PluginMediaModelChoices(),
  ) {}

  /**
   * Installed providers with media whose key is set, or that need none, of
   * plugins the person has allowed everything they ask for, such as their hosts.
   */
  async providers(): Promise<PluginMediaProvider[]> {
    const providers: PluginMediaProvider[] = [];
    for (const entry of await this.services.everyProject()) {
      for (const provider of entry.manifest.contributes?.providers ?? []) {
        if (!provider.media) continue;
        if (provider.apiKey && this.services.values.secret(entry, provider.apiKey) === undefined) continue;
        providers.push({ id: pluginModelProviderId(entry.id, provider.id), entry, provider, media: provider.media });
      }
    }
    return providers;
  }

  /** The image models of each provider that makes images, as the image catalog lists them. */
  async imageProviders(): Promise<Array<{ id: string; name: string; models: ImageModel[] }>> {
    return Promise.all((await this.providers()).filter((item) => item.media.image).map(async (item) => {
      const name = this.#name(item);
      return {
        id: item.id,
        name,
        models: (await this.#models(item, "image")).map((model): ImageModel => ({
          provider: item.id,
          providerName: name,
          id: model.id,
          name: model.title ? localizePluginString(item.entry, model.title, "en") : model.id,
          protocol: "plugin",
          sizes: [],
          generationOptions: model.resolutions.flatMap((resolution) => model.aspectRatios.map((aspectRatio) => ({ resolution, aspectRatio }))),
          supportsReferenceImage: (model.maxReferenceImages ?? 0) > 0,
          maxReferenceImages: model.maxReferenceImages ?? 0,
          maxOutputs: 1,
        })),
      };
    }));
  }

  /** The video models of each provider that makes videos, as the video catalog lists them. */
  async videoProviders(): Promise<Array<{ id: string; name: string; models: VideoModel[] }>> {
    return Promise.all((await this.providers()).filter((item) => item.media.video).map(async (item) => {
      const name = this.#name(item);
      return {
        id: item.id,
        name,
        models: (await this.#models(item, "video")).map((model): VideoModel => {
          const referenceModes: readonly VideoReferenceMode[] = model.referenceModes ?? ["frame"];
          return {
            provider: item.id,
            providerName: name,
            id: model.id,
            name: model.title ? localizePluginString(item.entry, model.title, "en") : model.id,
            durations: model.durations,
            resolutions: model.resolutions,
            aspectRatios: model.aspectRatios,
            maxImageReferences: model.maxReferenceImages ?? 0,
            imageReferenceMode: referenceModes[0]!,
            referenceModes,
            ...(model.imageAspectRatios ? { imageAspectRatios: model.imageAspectRatios } : {}),
            ...(model.frameAspectRatios ? { frameAspectRatios: model.frameAspectRatios } : {}),
          };
        }),
      };
    }));
  }

  /** The audio models of each provider that makes audio, as the audio catalog lists them, with their voices. */
  async audioProviders(): Promise<Array<{ id: string; name: string; models: AudioModel[]; voices: AudioVoice[] }>> {
    return Promise.all((await this.providers()).filter((item) => item.media.audio).map(async (item) => {
      const name = this.#name(item);
      const text = (value: string) => localizePluginString(item.entry, value, "en");
      const voices = new Map<string, AudioVoice>();
      const models = await this.#models(item, "audio");
      for (const model of models)
        for (const voice of model.voices ?? []) if (!voices.has(voice.id)) voices.set(voice.id, { id: voice.id, name: text(voice.name) });
      return {
        id: item.id,
        name,
        voices: [...voices.values()],
        models: models.map((model): AudioModel => ({
          provider: item.id,
          providerName: name,
          id: model.id,
          name: model.title ? text(model.title) : model.id,
          protocol: "plugin",
          capabilities: {
            produces: [...model.kinds],
            ...(model.readsText ? { readsText: true } : {}),
            ...(model.readsText && model.voices ? { supportsSpeaker: true } : {}),
            formats: [...(model.formats ?? ["mp3" as const])],
            ...(model.maxTextCharacters ? { maxTextCharacters: model.maxTextCharacters } : {}),
            ...(model.minDurationSeconds ? { minDurationSeconds: model.minDurationSeconds } : {}),
            ...(model.maxDurationSeconds ? { maxDurationSeconds: model.maxDurationSeconds } : {}),
            ...(model.instrumental ? { supportsInstrumental: true } : {}),
            ...(model.loop ? { supportsLoop: true } : {}),
          },
        })),
      };
    }));
  }

  /** Plugins' audio providers as the audio catalog takes them; `enabled` says whether one is switched on. */
  async audioAdapters(enabled: (id: string) => boolean): Promise<AudioProviderAdapter[]> {
    return (await this.audioProviders()).map((provider): AudioProviderAdapter => ({
      id: provider.id,
      name: provider.name,
      configured: () => true,
      enabled: () => enabled(provider.id),
      models: () => provider.models,
      ...(provider.voices.length ? {
        defaultVoiceId: () => provider.voices[0]!.id,
        voices: async () => ({ voices: provider.voices }),
      } : {}),
      generate: (input, signal, journal) => {
        const model = provider.models.find((candidate) => candidate.id === input.model?.id);
        if (!model) throw new AudioGenerationError("The selected audio model is unavailable", 400);
        return this.generateAudio(model, input, signal, journal);
      },
    }));
  }

  /** The 3D models of each provider that makes them, as the 3D catalog lists them. */
  async model3DProviders(): Promise<Array<{ id: string; name: string; models: Model3DModel[] }>> {
    return Promise.all((await this.providers()).filter((item) => item.media["3d"]).map(async (item) => {
      const name = this.#name(item);
      return {
        id: item.id,
        name,
        models: (await this.#models(item, "3d")).map((model): Model3DModel => ({
          provider: item.id,
          providerName: name,
          id: model.id,
          name: model.title ? localizePluginString(item.entry, model.title, "en") : model.id,
          operations: [...model.operations],
          maxReferenceImages: (model.operations as readonly string[]).includes("image") ? model.maxReferenceImages ?? 1 : 0,
          polycount: { min: model.polycount.min, max: model.polycount.max, default: model.polycount.default, presets: model.polycount.presets ?? [model.polycount.default] },
          supportsTexture: model.texture === true,
          supportsPbr: model.pbr === true,
          defaults: { texture: model.texture === true, pbr: false },
        })),
      };
    }));
  }

  /** Makes one audio file with a provider's adapter. */
  async generateAudio(model: AudioModel, input: AudioGenerationRequest, signal?: AbortSignal, journal?: MediaTaskJournal): Promise<GeneratedAudio> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    const declared = item?.media.audio && (await this.#models(item, "audio")).find((candidate) => candidate.id === model.id);
    if (!item?.media.audio || !declared) throw new AudioGenerationError("The selected audio provider is unavailable. Check its plugin and key.", 503);
    if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new AudioGenerationError("Audio needs a prompt", 400);
    const formats = model.capabilities.formats;
    // A format the person picked must be what comes back; otherwise the model's first is asked for,
    // and any audio OhMyGame keeps is taken, since some vendors don't say which file a model makes.
    const asked = input.output?.format;
    const format = asked ?? formats[0]!;
    if (!formats.includes(format)) throw new AudioGenerationError(`The selected audio model doesn't make ${format}`, 400);
    const { maxTextCharacters, minDurationSeconds, maxDurationSeconds } = model.capabilities;
    if (maxTextCharacters && input.prompt.length > maxTextCharacters) throw new AudioGenerationError(`The selected audio model takes up to ${maxTextCharacters} characters`, 400);
    if (input.durationSeconds !== undefined && (minDurationSeconds && input.durationSeconds < minDurationSeconds || maxDurationSeconds && input.durationSeconds > maxDurationSeconds))
      throw new AudioGenerationError(`The selected audio model makes ${minDurationSeconds ?? 1} to ${maxDurationSeconds ?? "any number of"} seconds`, 400);
    const voices = declared.voices ?? [];
    if (input.voiceId && model.capabilities.readsText && voices.length && !voices.some((voice) => voice.id === input.voiceId))
      throw new AudioGenerationError("The selected voice isn't one this model speaks in", 400);
    const kind = input.kind && model.capabilities.produces.includes(input.kind) ? input.kind : model.capabilities.produces[0]!;
    const voiceId = model.capabilities.readsText ? input.voiceId ?? voices[0]?.id : undefined;
    return this.#produce(item, "audio", {
      model: model.id,
      kind,
      prompt: input.prompt,
      format,
      ...(voiceId ? { voiceId } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.instrumental && model.capabilities.supportsInstrumental ? { instrumental: true } : {}),
      ...(input.loop && model.capabilities.supportsLoop ? { loop: true } : {}),
      ...(input.language ? { language: input.language } : {}),
      // The canvas offers a speed for every speech model, on the shared -50…100 scale.
      ...(kind === "speech" && input.speed ? { speed: input.speed } : {}),
      ...modelData(declared),
    }, { limitMs: item.media.audio.maxMinutes ? item.media.audio.maxMinutes * 60_000 : AUDIO_LIMIT_MS, signal, Failure: AudioFailure, journal }, async (outputs, stopped) => {
      const bytes = await this.#output(item, outputs[0]!, AUDIO_MAX_BYTES, DOWNLOAD_TIMEOUT_MS, AudioFailure, stopped);
      const audio = await inspectAudio(bytes, asked, 502).catch((cause: unknown) => {
        throw asked ? cause : new AudioFailure(`${this.#name(item)} returned a file that isn't playable audio`);
      });
      const made = asked ?? audioFormat(audio);
      if (!made) throw new AudioFailure(`${this.#name(item)} returned ${audio.mime} audio, which isn't MP3, WAV or Ogg Opus`);
      return {
        bytes,
        mediaType: AUDIO_MEDIA_TYPES[made],
        model: { provider: model.provider, id: model.id },
        metadata: { durationMs: audio.durationMs, sampleRate: audio.sampleRate, channels: audio.channels, codec: audio.codec },
      };
    });
  }

  /**
   * Makes one 3D model with a provider's adapter, from a prompt or pictures.
   * With a journal, the vendor's task is kept, so retrying after a restart
   * checks it again.
   */
  async generate3D(model: Model3DModel, input: Model3DGenerationInput, signal?: AbortSignal, journal?: MediaTaskJournal): Promise<Generated3DModel> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    if (!item?.media["3d"]) throw new Model3DGenerationError("The selected 3D provider is unavailable. Check its plugin and key.", 503);
    const operation = input.operation ?? "image";
    if (operation !== "text" && operation !== "image" || !(model.operations ?? []).includes(operation))
      throw new Model3DGenerationError("The selected 3D model does not support this operation", 400);
    const images = operation === "image" ? input.images : [];
    if (operation === "image" && (!images.length || images.length > model.maxReferenceImages)) throw new Model3DGenerationError(`The selected 3D model takes 1 to ${model.maxReferenceImages} pictures`, 400);
    if (operation === "text" && !input.prompt?.trim()) throw new Model3DGenerationError("Text-to-3D needs a prompt", 400);
    const polycount = input.targetPolycount ?? model.polycount.default;
    if (polycount < model.polycount.min || polycount > model.polycount.max) throw new Model3DGenerationError(`3D poly count must be between ${model.polycount.min} and ${model.polycount.max}`, 400);
    const texture = (input.texture ?? model.defaults?.texture ?? false) && model.supportsTexture === true;
    const declared = (await this.#models(item, "3d")).find((candidate) => candidate.id === model.id);
    const files = item.media["3d"].inputFiles ? new MediaInputFiles() : undefined;
    const references = images.map((image, index) => {
      if (!files) return { mediaType: image.mediaType, base64: image.data };
      if (image.data.length > Math.ceil(20 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Model3DGenerationError("Invalid 3D reference image (maximum 20 MB)", 400);
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.length > 20 * 1024 * 1024 || sniffImageType(bytes) !== image.mediaType) throw new Model3DGenerationError("3D reference must be a PNG, JPEG or WebP image up to 20 MB", 400);
      return files.add(bytes, image.mediaType, `reference-${index}.${image.mediaType === "image/jpeg" ? "jpg" : image.mediaType === "image/png" ? "png" : "webp"}`);
    });
    return this.#produce(item, "3d", {
      model: model.id,
      operation,
      ...(operation === "text" ? { prompt: input.prompt!.trim() } : {}),
      references,
      targetPolycount: polycount,
      texture,
      pbr: texture && input.pbr === true && model.supportsPbr === true,
      ...modelData(declared),
    }, { limitMs: item.media["3d"].maxMinutes ? item.media["3d"].maxMinutes * 60_000 : MODEL3D_LIMIT_MS, signal, Failure: Model3DGenerationError, journal, ...(files ? { files } : {}) }, async (outputs, stopped) => {
      const bytes = await this.#output(item, outputs[0]!, MODEL3D_MAX_BYTES, DOWNLOAD_TIMEOUT_MS, Model3DGenerationError, stopped);
      if (bytes.length < 12 || bytes.subarray(0, 4).toString("latin1") !== "glTF" || bytes.readUInt32LE(4) !== 2)
        throw new Model3DGenerationError(`${this.#name(item)} returned a file that isn't a GLB model`);
      return { bytes, mediaType: "model/gltf-binary" as const };
    });
  }

  /** Makes one picture with a provider's adapter. */
  async generateImage(model: ImageModel, input: Omit<ImageGenerationInput, "imageModel">, signal?: AbortSignal): Promise<GeneratedImage> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    if (!item?.media.image) throw new ImageGenerationError("The selected image provider is unavailable. Check its plugin and key.", 503);
    const declared = (await this.#models(item, "image")).find((candidate) => candidate.id === model.id);
    return this.#produce(item, "image", {
      model: model.id,
      prompt: input.prompt,
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.transparentBackground ? { transparentBackground: true } : {}),
      references: (input.images ?? []).map((image: PromptImage) => ({ mediaType: image.mediaType, base64: image.data })),
      ...modelData(declared),
    }, { limitMs: IMAGE_LIMIT_MS, signal, Failure: ImageGenerationError }, async (outputs, stopped) => {
      const bytes = await this.#output(item, outputs[0]!, RESPONSE_MAX_BYTES, REQUEST_TIMEOUT_MS, ImageGenerationError, stopped);
      const mediaType = sniffImageType(bytes);
      if (!mediaType) throw new ImageGenerationError(`${this.#name(item)} returned a file that isn't a PNG, JPEG or WebP picture`);
      return { bytes, mediaType };
    });
  }

  /**
   * Makes one video with a provider's adapter. With a journal, the vendor's
   * task is kept, so retrying after a restart checks it again.
   */
  async generateVideo(model: VideoModel, input: VideoGenerationInput, signal?: AbortSignal, journal?: MediaTaskJournal): Promise<GeneratedVideo> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    if (!item?.media.video) throw new VideoGenerationError("The selected video provider is unavailable. Check its plugin and key.", 503);
    const duration = input.duration ?? model.durations[0]!;
    const resolution = input.resolution ?? model.resolutions[0]!;
    const references = input.references ?? [];
    const referenceMode = input.referenceMode ?? model.imageReferenceMode ?? "frame";
    const ratios = videoReferenceAspectRatios(model, references.length, referenceMode);
    const aspectRatio = input.aspectRatio ?? ratios[0]!;
    if (!model.durations.includes(duration)) throw new VideoGenerationError("Video duration is not supported by the selected model", 400);
    if (!model.resolutions.includes(resolution)) throw new VideoGenerationError("Video resolution is not supported by the selected model", 400);
    if (!ratios.includes(aspectRatio)) throw new VideoGenerationError("Video aspect ratio is not supported by the selected model", 400);
    if (references.length && !(model.referenceModes ?? [referenceMode]).includes(referenceMode)) throw new VideoGenerationError("The selected video model does not support this reference mode", 400);
    if (references.some((reference) => reference.type !== "image")) throw new VideoGenerationError("Plugin video providers take image references only", 400);
    // As frames, two at most: the first and the last.
    const maxReferences = referenceMode === "frame" ? Math.min(2, model.maxImageReferences) : model.maxImageReferences;
    if (references.length > maxReferences) throw new VideoGenerationError(`The selected video model supports up to ${maxReferences} reference images`, 400);
    const pictures = await Promise.all(references.map(async (reference) => ({ mediaType: reference.mediaType, base64: (await readFile(reference.absolutePath)).toString("base64") })));
    const declared = (await this.#models(item, "video")).find((candidate) => candidate.id === model.id);
    return this.#produce(item, "video", {
      model: model.id,
      prompt: input.prompt,
      duration,
      resolution,
      aspectRatio,
      ...(pictures.length ? { referenceMode } : {}),
      references: pictures,
      ...modelData(declared),
    }, { limitMs: item.media.video.maxMinutes ? item.media.video.maxMinutes * 60_000 : VIDEO_LIMIT_MS, signal, Failure: VideoGenerationError, journal }, async (outputs, stopped) => {
      const bytes = await this.#output(item, outputs[0]!, VIDEO_MAX_BYTES, DOWNLOAD_TIMEOUT_MS, VideoGenerationError, stopped);
      if (bytes.length < 12 || bytes.subarray(4, 8).toString("latin1") !== "ftyp") throw new VideoGenerationError(`${this.#name(item)} returned a file that isn't an MP4 video`);
      return { bytes, mediaType: "video/mp4" };
    });
  }

  /**
   * A kind's models in Settings: the manifest's, those turned on, and, once
   * listed (`refresh`), the rest the adapter found.
   */
  async listModels(providerId: string, kind: PluginMediaKind, refresh = false): Promise<PluginMediaModelList> {
    const item = await this.#provider(providerId, kind);
    const section = item.media[kind]!;
    const discoverable = section.discoverModels === true;
    if (refresh && discoverable) await this.#discover(item, kind);
    const { hidden, added } = await this.choices.get(item.id, kind);
    const listed = discoverable ? this.#listed.get(this.#listKey(item, kind)) : undefined;
    const text = (value: string) => localizePluginString(item.entry, value, "en");
    const row = (model: PluginMediaModel, isDefault: boolean, shown: boolean) => ({
      id: model.id,
      name: model.title ? text(model.title) : model.id,
      ...(model.description ? { description: text(model.description) } : {}),
      default: isDefault,
      shown,
    });
    const seen = new Set<string>();
    const models: PluginMediaModelList["models"] = [];
    const add = (model: PluginMediaModel, isDefault: boolean, shown: boolean) => {
      if (seen.has(model.id)) return;
      seen.add(model.id);
      models.push(row(model, isDefault, shown));
    };
    for (const model of section.models) add(model, true, !hidden.includes(model.id));
    if (discoverable) {
      for (const model of added) add(model, false, true);
      for (const model of listed?.models ?? []) add(model, false, false);
    }
    return { kind, discoverable, ...(listed ? { listedAt: listed.at, ...(listed.skipped ? { skipped: listed.skipped } : {}) } : {}), models };
  }

  /** Turns models of a kind on or off; one the adapter listed must have been listed in this session to be turned on. */
  async setModelsShown(providerId: string, kind: PluginMediaKind, ids: string[], shown: boolean): Promise<PluginMediaModelList> {
    const item = await this.#provider(providerId, kind);
    const section = item.media[kind]!;
    const defaults = new Set(section.models.map((model) => model.id));
    const listed = section.discoverModels ? this.#listed.get(this.#listKey(item, kind))?.models ?? [] : [];
    await this.choices.update(item.id, kind, (choice) => {
      const hidden = new Set(choice.hidden);
      const added = new Map(choice.added.map((model) => [model.id, model]));
      for (const id of ids) {
        if (defaults.has(id)) {
          if (shown) hidden.delete(id);
          else hidden.add(id);
        } else if (!shown) {
          added.delete(id);
        } else if (!added.has(id)) {
          const model = listed.find((candidate) => candidate.id === id);
          if (!model) throw new PluginMediaModelChoiceError(`${id} isn't among the models ${this.#name(item)} listed. List them again.`, 409);
          added.set(id, model);
        }
      }
      // Ids of models the manifest no longer lists are dropped, so a stale one isn't kept forever.
      return { added: [...added.values()], hidden: [...hidden].filter((id) => defaults.has(id)) };
    });
    return this.listModels(providerId, kind);
  }

  /** A provider that makes a kind, whose key is set. */
  async #provider(providerId: string, kind: PluginMediaKind): Promise<PluginMediaProvider> {
    const item = (await this.providers()).find((candidate) => candidate.id === providerId);
    if (!item?.media[kind]) throw new PluginMediaModelChoiceError(`${providerId} doesn't make ${kind === "3d" ? "3D models" : kind}, or its key isn't set`, 404);
    return item;
  }

  /** The models of a kind a request can use: the manifest's that are on, then those turned on from the adapter's list. */
  async #models<K extends PluginMediaKind>(item: PluginMediaProvider, kind: K): Promise<Array<PluginMediaModels[K]>> {
    const section = item.media[kind];
    if (!section) return [];
    const defaults = section.models as Array<PluginMediaModels[K]>;
    const { hidden, added } = await this.choices.get(item.id, kind);
    const ids = new Set(defaults.map((model) => model.id));
    return [
      ...defaults.filter((model) => !hidden.includes(model.id)),
      ...(section.discoverModels ? added.filter((model) => !ids.has(model.id)) : []),
    ];
  }

  #listKey(item: PluginMediaProvider, kind: PluginMediaKind): string {
    return `${item.id}\0${kind}\0${item.entry.digest}`;
  }

  /** Runs the adapter's `models` step for a kind and keeps the models that pass the checks. */
  async #discover(item: PluginMediaProvider, kind: PluginMediaKind): Promise<void> {
    const name = this.#name(item);
    const source = await this.#source(item, PluginMediaModelChoiceError);
    const answer = await runMediaAdapter({
      source, file: item.media.adapter, kind, step: "models", args: [],
      fetch: (request, signal) => this.#fetch(item, request, signal),
      log: (message) => this.log(item.entry.id, message),
      cpuMs: LIST_CPU_MS,
      callMs: LIST_CALL_MS,
    }).catch((cause: unknown) => {
      throw new PluginMediaModelChoiceError(`${name} couldn't list its models: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
    });
    const values = answer && typeof answer === "object" && Array.isArray((answer as { models?: unknown }).models) ? (answer as { models: unknown[] }).models : undefined;
    if (!values) {
      const error = answer && typeof answer === "object" && typeof (answer as { error?: unknown }).error === "string" ? (answer as { error: string }).error : "it returned no models";
      throw new PluginMediaModelChoiceError(`${name} couldn't list its models: ${error}`, 502);
    }
    const models: PluginMediaModel[] = [];
    const ids = new Set<string>();
    let skipped = 0;
    for (const value of values.slice(0, LIST_MAX_MODELS)) {
      const problem = pluginMediaModelProblem(kind, value);
      const id = (value as { id?: unknown })?.id;
      if (problem || ids.has(id as string)) {
        skipped += 1;
        if (problem) this.log(item.entry.id, `Listed ${kind} model ${typeof id === "string" ? id : "without an id"} left out: ${problem}`);
        continue;
      }
      ids.add(id as string);
      models.push(value as PluginMediaModel);
    }
    skipped += Math.max(0, values.length - LIST_MAX_MODELS);
    this.#listed.set(this.#listKey(item, kind), { models, at: new Date().toISOString(), skipped });
  }

  /**
   * Runs `start`, then `check` while the vendor works, until there are
   * outputs, and `finish` on them, all within the kind's time limit.
   */
  async #produce<T>(item: PluginMediaProvider, kind: string, input: unknown, options: RunOptions, finish: (outputs: Output[], stopped: AbortSignal) => Promise<T>): Promise<T> {
    const { limitMs, signal, Failure, journal } = options;
    const name = this.#name(item);
    const source = await this.#source(item, Failure);
    const outOfTime = new Failure(`${name} took longer than ${Math.round(limitMs / 60_000)} minutes`, 504);
    const deadline = AbortSignal.timeout(limitMs);
    const stopped = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Out of time reads as such; stopped by the person or the app, as they stopped it.
    const why = (aborted: AbortSignal) => deadline.aborted && aborted.reason === deadline.reason ? outOfTime : aborted.reason as unknown;
    // Whether `start` sent anything but a read: the vendor may have taken it, whatever came of the answer.
    let submitted = false;
    const call = (step: string, args: unknown[], stepSignal: AbortSignal) => runMediaAdapter({
      source, file: item.media.adapter, kind, step, args,
      fetch: async (request, fetchSignal) => {
        const timeout = kind === "image" && step === "start" ? IMAGE_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        if ("submission" in request) {
          if (!journal || !["start", "check"].includes(step)) throw new Error("host.submit needs a recoverable generation and a start or check step");
          if (typeof request.submission !== "string") throw new Error("host.submit needs a stable submission id");
          const { submission, ...fetchRequest } = request;
          submitted = true;
          return journal.submit(submission, item.entry.digest, fetchRequest, () => {
            fetchSignal.throwIfAborted();
            return this.#fetch(item, fetchRequest, fetchSignal, undefined, timeout, options.files);
          });
        }
        if (journal && step === "start" && !["GET", "HEAD"].includes((request.method ?? "GET").toUpperCase())) await journal.unsafeStart();
        return this.#fetch(item, request, fetchSignal, step === "start" ? () => { submitted = true; } : undefined, timeout, options.files);
      },
      ...(kind === "image" && step === "start" ? { callMs: IMAGE_REQUEST_TIMEOUT_MS } : {}),
      log: (message) => this.log(item.entry.id, message),
      signal: stepSignal,
    }).catch((cause: unknown) => {
      if (stepSignal.aborted) throw why(stepSignal);
      throw new Failure(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });

    let begun: MediaTaskStart = { state: "new" };
    if (journal) {
      try {
        // With the key's digest, so a task isn't checked with another account's key.
        const key = item.provider.apiKey ? this.services.values.secret(item.entry, item.provider.apiKey) : undefined;
        const account = key === undefined ? undefined : createHash("sha256").update(key).digest("hex").slice(0, 16);
        begun = await journal.begin({ plugin: item.entry.id, provider: item.provider.id, account, kind, input });
      } catch (cause) {
        journal.release();
        throw cause instanceof MediaTaskBusyError ? new Failure(cause.message, 409) : cause;
      }
      if (begun.state === "changed" || begun.state === "unconfirmed") {
        journal.release();
        throw new Failure(begun.state === "changed"
          ? `${name}: the provider, its key or the request changed since this ${kind} started. Restore them to resume, or start a new generation.`
          : `${name} may have started this ${kind} already, but its answer was lost. Check ${name}'s own site before starting a new one; retrying won't start another.`, 409);
      }
    }
    let task = begun.state === "resume" ? begun.task : undefined;
    let saved = task === undefined ? undefined : JSON.stringify(task);
    // Whether the vendor answered for good; until then, a failure leaves its task running.
    let settled = false;
    // Whether the vendor has the result ready, so only fetching it is left.
    let ready = false;
    // Whether the journal keeps the request after this run, for a retry to resume.
    let keep = false;
    try {
      let answer: Answer;
      if (begun.state === "resume") answer = { task, retryAfter: 1 };
      // The vendor finished in an earlier run: fetch its result again.
      else if (begun.state === "done") answer = answerOf({ outputs: begun.outputs }, undefined, Failure);
      else {
        try {
          answer = answerOf(await call("start", [input], stopped), undefined, Failure);
        } catch (cause) {
          // Never send a start again that may have reached the vendor; only `{ error }` says it didn't.
          if (submitted) keep = true;
          throw cause;
        }
      }
      let wait = 2;
      let failures = 0;
      while ("task" in answer) {
        task = answer.task;
        const text = JSON.stringify(task);
        if (journal && text !== saved) {
          await journal.save(task);
          saved = text;
        }
        // The adapter's pace, kept between 1 s and a minute; without one, 2 s growing to 15 s.
        const seconds = answer.retryAfter !== undefined ? Math.min(60, Math.max(1, answer.retryAfter)) : wait;
        wait = Math.min(15, wait * 1.5);
        await delay(seconds * 1000, stopped).catch(() => { throw why(stopped); });
        try {
          answer = answerOf(await call("check", [task], stopped), task, Failure);
          failures = 0;
        } catch (cause) {
          // Left as it was, the answer has the loop check the same task again after the wait.
          if (stopped.aborted || ++failures > CHECK_RETRIES) throw cause;
        }
      }
      settled = true;
      if ("error" in answer) throw new Failure(`${name}: ${answer.error}`);
      ready = true;
      // Kept until the caller stores the result. A task is checked again for a fresh address;
      // a vendor that answered at once left none, so its result is kept instead.
      if (journal && task === undefined && begun.state !== "done") await journal.finish(answer.outputs).catch(() => {});
      const result = await finish(answer.outputs, stopped);
      keep = true;
      return result;
    } catch (cause) {
      const shutdown = signal?.aborted && signal.reason instanceof GenerationShutdown;
      if (shutdown) {
        // The app is closing: keep the task for a retry to resume, and let the vendor go on.
        if (task !== undefined || ready) keep = true;
      } else if (ready) {
        // A failed or stopped download must not discard an already-paid result.
        keep = true;
      } else if (!settled && task !== undefined) {
        // A failed check or local stop does not prove that the remote task ended.
        // Retain ownership even if cancel is missing, fails, or races completion.
        keep = true;
        if (stopped.aborted || !journal) {
          // Non-journaled operations retain their existing cleanup on failure.
          // Hold the journal lease until this bounded attempt finishes, so a
          // retry cannot race a detached cancellation of the same remote task.
          await call("cancel", [task], AbortSignal.timeout(CANCEL_LIMIT_MS)).catch(() => {});
        }
      }
      throw cause;
    } finally {
      if (journal) {
        if (!keep && !journal.hasSubmissions()) await journal.clear().catch(() => {});
        journal.release();
      }
    }
  }

  /** The adapter's source, read once per package. */
  #source(item: PluginMediaProvider, Failure: Failure): Promise<string> {
    const key = `${item.entry.root}\0${item.entry.digest}\0${item.media.adapter}`;
    let source = this.#sources.get(key);
    if (!source) {
      source = (async () => {
        const root = await realpath(item.entry.root);
        const file = await realpath(path.resolve(root, item.media.adapter));
        if (!file.startsWith(root + path.sep)) throw new Error(`${item.media.adapter} is outside the package`);
        const bytes = await readFile(file);
        if (bytes.length > PLUGIN_MEDIA_ADAPTER_MAX_BYTES) throw new Error(`${item.media.adapter} is larger than 512 KB`);
        return bytes.toString("utf8");
      })();
      source.catch(() => this.#sources.delete(key));
      this.#sources.set(key, source);
    }
    return source.catch((cause: unknown) => {
      throw new Failure(`${this.#name(item)}: ${cause instanceof Error ? cause.message : String(cause)}`, 503);
    });
  }

  /**
   * `host.fetch`: HTTPS to the plugin's approved hosts, with the key added
   * when asked. `writing` hears of a request sent that isn't a read.
   */
  async #fetch(item: PluginMediaProvider, request: MediaFetchRequest, signal: AbortSignal, writing?: () => void, timeoutMs = REQUEST_TIMEOUT_MS, files?: MediaInputFiles): Promise<MediaFetchResponse> {
    if (request && "submission" in request) throw new Error("host.submit is only available during a recoverable generation");
    const url = this.#allowed(item, request?.url);
    const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    if (!METHODS.has(method)) throw new Error(`host.fetch can't send ${method}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers && typeof request.headers === "object" ? request.headers : {}))
      if (typeof value === "string") headers.set(name, value);
    headers.delete("cookie");
    let body: string | FormData | undefined;
    if (request.multipart !== undefined) {
      if (!files) throw new Error("Multipart needs generation-owned input files");
      if (request.json !== undefined || request.body !== undefined || method === "GET" || method === "HEAD") throw new Error("Multipart needs a write method and cannot be combined with json or body");
      body = files.multipart(request.multipart);
      headers.delete("content-type");
      headers.delete("content-length");
    } else if (request.json !== undefined) {
      body = files ? files.json(request.json) : JSON.stringify(request.json);
      if (files) headers.delete("content-length");
      headers.set("content-type", "application/json");
    } else if (typeof request.body === "string") body = request.body;
    let key: string | undefined;
    if (request.auth === true) {
      key = item.provider.apiKey ? this.services.values.secret(item.entry, item.provider.apiKey) : undefined;
      if (!key) throw new Error("the provider has no key to send");
      const auth = item.media.auth ?? DEFAULT_AUTH;
      if ("query" in auth) url.searchParams.set(auth.query, key);
      else headers.set(auth.header, auth.scheme ? `${auth.scheme} ${key}` : key);
    }
    if (method !== "GET" && method !== "HEAD") writing?.();
    const response = await this.request(url, {
      method,
      headers,
      ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    }).catch((cause: unknown) => {
      // Never the address: it may carry the key.
      throw new Error(`${url.host} could not be reached${cause instanceof Error && cause.name === "TimeoutError" ? " in time" : ""}`);
    });
    // An answer may echo the key, as a redirect to the same address would: the adapter never sees it.
    const json = key === undefined ? "" : JSON.stringify(key).slice(1, -1);
    const forms = key === undefined ? [] : [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2), json, json.replaceAll("/", "\\/")])];
    const hide = (text: string) => forms.reduce((hidden, form) => hidden.split(form).join("[key]"), text);
    // JSON can spell the key with escapes (`\u0073k-…`) that `json()` undoes: written out again, they read plainly.
    // That is done to the vendor's own text, before anything in it is replaced, and the
    // adapter then gets only that form, for text() as for json().
    const hideBody = (text: string) => {
      if (key !== undefined) {
        try {
          return hide(JSON.stringify(JSON.parse(text)));
        } catch { /* not JSON */ }
      }
      return hide(text);
    };
    const answer: Record<string, string> = {};
    for (const name of ANSWER_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) answer[name] = hide(value);
    }
    return { status: response.status, headers: answer, body: hideBody((await readCapped(response, url.host, RESPONSE_MAX_BYTES)).toString("utf8")) };
  }

  /** Downloads or decodes one output. */
  async #output(item: PluginMediaProvider, output: Output, maxBytes: number, timeoutMs: number, Failure: Failure, signal: AbortSignal): Promise<Buffer> {
    if ("base64" in output) {
      const bytes = Buffer.from(output.base64, "base64");
      if (!bytes.length || bytes.length > maxBytes) throw new Failure(`${this.#name(item)} returned an empty or oversized file`);
      return bytes;
    }
    const url = this.#allowed(item, output.url, Failure);
    const response = await this.request(url, {
      redirect: "manual", credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    }).catch((cause: unknown) => {
      if (signal.aborted) throw signal.reason;
      throw new Failure(`${this.#name(item)}'s result at ${url.host} could not be downloaded${cause instanceof Error && cause.name === "TimeoutError" ? " in time" : ""}`);
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Failure(`${this.#name(item)}'s result at ${url.host} answered ${response.status}`);
    }
    return readCapped(response, url.host, maxBytes).catch((cause: unknown) => {
      if (signal.aborted) throw signal.reason;
      throw new Failure(`${this.#name(item)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  /** An HTTPS address on a host the plugin's `capabilities.network` lists. */
  #allowed(item: PluginMediaProvider, value: unknown, Failure: Failure = Error): URL {
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      throw new Failure("host.fetch needs an https address");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new Failure("host.fetch needs an https address without a user name");
    if (!networkCovers(item.entry.manifest.capabilities?.network, url)) throw new Failure(`${url.host} isn't in the plugin's capabilities.network`);
    return url;
  }

  #name(item: PluginMediaProvider): string {
    return localizePluginString(item.entry, item.provider.title, "en");
  }
}

/** Reads what a step returned; anything else is the adapter's mistake. */
function answerOf(value: unknown, task: unknown, Failure: Failure): Answer {
  const fail = (why: string): never => { throw new Failure(`The plugin's adapter ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("returned neither outputs, a task nor an error");
  const answer = value as Record<string, unknown>;
  if (typeof answer.error === "string") return { error: answer.error.slice(0, 1000) };
  if (Array.isArray(answer.outputs)) {
    const outputs = answer.outputs.filter((output): output is Output => Boolean(output) && typeof output === "object"
      && (typeof (output as { url?: unknown }).url === "string" || typeof (output as { base64?: unknown }).base64 === "string"));
    return outputs.length ? { outputs } : fail("returned no outputs");
  }
  const next = "task" in answer ? answer.task : task;
  if (next === undefined) return fail("returned neither outputs, a task nor an error");
  if (JSON.stringify(next).length > TASK_MAX_CHARACTERS) return fail("returned a task larger than 16 KB");
  return { task: next, ...(typeof answer.retryAfter === "number" && Number.isFinite(answer.retryAfter) ? { retryAfter: answer.retryAfter } : {}) };
}

/** Reads an answer up to `maxBytes`, letting go of the rest of a larger one. */
async function readCapped(response: Response, host: string, maxBytes: number): Promise<Buffer> {
  const tooLarge = `${host} answered with more than ${Math.round(maxBytes / 1024 / 1024)} MB`;
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(tooLarge);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    // Leaving the loop early cancels the body.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error(tooLarge);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
