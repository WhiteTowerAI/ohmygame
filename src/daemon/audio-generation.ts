import {
  type AudioGenerationRequest,
  type AudioKind,
  type AudioModel,
  type AudioModelCatalog,
  type AudioTranscription,
  type AudioTranscriptionRequest,
  type AudioVoicePage,
  type GeneratedAudio,
} from "../shared/audio.js";
import { currentAudioModel } from "../shared/audio-legacy.js";
import type { ModelRef } from "../shared/contracts.js";

export class AudioGenerationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface AudioProviderAdapter {
  readonly id: string;
  readonly name: string;
  defaultVoiceId?(): string | undefined;
  configured(): boolean;
  enabled(): boolean;
  models(): AudioModel[];
  generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
  /** Lists voices from the account, for providers without a built-in list. */
  voices?(query: { search?: string; pageToken?: string }, signal?: AbortSignal): Promise<AudioVoicePage>;
  /** Turns audio into text with a model that sets `transcribes`. */
  transcribe?(input: AudioTranscriptionRequest, signal?: AbortSignal): Promise<AudioTranscription>;
}

export interface AudioGenerator {
  catalog(): Promise<AudioModelCatalog> | AudioModelCatalog;
  generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
  voices?(provider: string, query: { search?: string; pageToken?: string }, signal?: AbortSignal): Promise<AudioVoicePage>;
  transcribe?(input: AudioTranscriptionRequest, signal?: AbortSignal): Promise<AudioTranscription>;
}

export class ProviderAudio implements AudioGenerator {
  constructor(
    /** The built-in providers, and those plugins add, which come and go. */
    private readonly adapters: readonly AudioProviderAdapter[] | (() => Promise<readonly AudioProviderAdapter[]>),
    /** The global default model for each kind. */
    private readonly defaults: () => Partial<Record<AudioKind, ModelRef>> = () => ({}),
  ) {}

  async #adapters(): Promise<readonly AudioProviderAdapter[]> {
    return typeof this.adapters === "function" ? this.adapters() : this.adapters;
  }

  async catalog(): Promise<AudioModelCatalog> {
    const defaultModels = this.defaults();
    const adapters = await this.#adapters();
    const providers = adapters.map((adapter) => {
      const configured = adapter.configured();
      const enabled = adapter.enabled();
      return {
        provider: adapter.id,
        name: adapter.name,
        ...(adapter.defaultVoiceId?.() ? { defaultVoiceId: adapter.defaultVoiceId() } : {}),
        ...(adapter.voices ? { listsVoices: true } : {}),
        configured,
        state: !enabled
          ? ("disabled" as const)
          : configured
            ? ("ready" as const)
            : ("not_configured" as const),
        ...(!configured
          ? { message: `Connect ${adapter.name} before generating audio.` }
          : {}),
      };
    });
    return {
      models: adapters
        .filter((adapter) => adapter.configured() && adapter.enabled())
        .flatMap((adapter) => adapter.models()),
      providers,
      ...(Object.keys(defaultModels).length ? { defaultModels } : {}),
    };
  }

  /**
   * The requested model; or else the project's default for the kind, then the global one, skipping a default
   * that isn't ready; or else the first ready model that makes the kind, preferring models that read text for
   * speech. Without a kind, the speech defaults apply, as they do to a new audio node.
   */
  async resolveModel(requested?: ModelRef, kind?: AudioKind, projectDefaults?: Partial<Record<AudioKind, ModelRef>>): Promise<AudioModel | undefined> {
    const models = (await this.catalog()).models.filter((model) => model.capabilities.produces.length);
    if (requested) return models.find((model) => sameModel(model, currentAudioModel(requested)));
    const fitting = kind ? models.filter((model) => model.capabilities.produces.includes(kind)) : models;
    const defaultKind = kind ?? "speech";
    const preferred = [projectDefaults?.[defaultKind], this.defaults()[defaultKind]];
    for (const model of preferred) {
      const ready = model && fitting.find((candidate) => sameModel(candidate, model));
      if (ready) return ready;
    }
    return (kind === "speech" ? fitting.find((model) => model.capabilities.readsText) : undefined) ?? fitting[0];
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    const model = await this.resolveModel(input.model, input.kind);
    if (!model) {
      if (input.model)
        throw new AudioGenerationError("The selected audio model is unavailable", 400);
      throw new AudioGenerationError(
        `No ${input.kind ? `${input.kind.replace("-", " ")} ` : ""}audio model is available. Connect an audio provider first.`,
        503,
      );
    }
    const adapter = (await this.#adapters()).find(
      (candidate) => candidate.id === model.provider,
    );
    if (!adapter)
      throw new AudioGenerationError(
        "The selected audio provider is unavailable",
        503,
      );
    return adapter.generate({ ...forModel(input, model), model: { provider: model.provider, id: model.id } }, signal);
  }

  /** One page of a provider's account voices. */
  async voices(provider: string, query: { search?: string; pageToken?: string }, signal?: AbortSignal): Promise<AudioVoicePage> {
    const adapter = (await this.#adapters()).find((candidate) => candidate.id === provider);
    if (!adapter?.voices) throw new AudioGenerationError("This audio provider has no voice list", 404);
    if (!adapter.enabled()) throw new AudioGenerationError(`${adapter.name} is disabled`, 503);
    if (!adapter.configured()) throw new AudioGenerationError(`Connect ${adapter.name} before listing its voices`, 503);
    return adapter.voices(query, signal);
  }

  /** Transcribes with the requested model, or the first ready one that can. */
  async transcribe(input: AudioTranscriptionRequest, signal?: AbortSignal): Promise<AudioTranscription> {
    const model = (await this.catalog()).models.find((candidate) => candidate.capabilities.transcribes && (!input.model || sameModel(candidate, input.model)));
    if (!model) {
      throw input.model
        ? new AudioGenerationError("The selected transcription model is unavailable", 400)
        : new AudioGenerationError("No transcription model is available. Connect an audio provider that transcribes speech first.", 503);
    }
    const adapter = (await this.#adapters()).find((candidate) => candidate.id === model.provider);
    if (!adapter?.transcribe) throw new AudioGenerationError("The selected audio provider cannot transcribe", 503);
    return adapter.transcribe({ ...input, model: { provider: model.provider, id: model.id } }, signal);
  }
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * One request serves every model, so it may carry options the chosen model doesn't take, such as a
 * length kept from a node's earlier model. Those are dropped; the adapter checks the rest.
 */
function forModel(input: AudioGenerationRequest, model: AudioModel): AudioGenerationRequest {
  const caps = model.capabilities;
  const { kind, durationSeconds, loop, instrumental, voiceId, ...rest } = input;
  return {
    ...rest,
    // Which of its kinds is wanted, for a model that makes more than one.
    ...(kind && caps.produces.length > 1 && caps.produces.includes(kind) ? { kind } : {}),
    ...(durationSeconds !== undefined && caps.maxDurationSeconds !== undefined ? { durationSeconds } : {}),
    ...(loop !== undefined && caps.supportsLoop ? { loop } : {}),
    ...(instrumental !== undefined && caps.supportsInstrumental ? { instrumental } : {}),
    ...(voiceId !== undefined && caps.supportsSpeaker ? { voiceId } : {}),
  };
}
