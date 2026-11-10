import {
  type AudioGenerationRequest,
  type AudioModel,
  type AudioModelCatalog,
  type AudioModelOperation,
  type AudioTranscription,
  type AudioTranscriptionRequest,
  type AudioVoicePage,
  type GeneratedAudio,
} from "../shared/audio.js";
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
  /** Turns audio into text with a model that lists the `transcription` operation. */
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
  constructor(private readonly adapters: readonly AudioProviderAdapter[]) {}

  catalog(): AudioModelCatalog {
    const providers = this.adapters.map((adapter) => {
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
      models: this.adapters
        .filter((adapter) => adapter.configured() && adapter.enabled())
        .flatMap((adapter) => adapter.models()),
      providers,
    };
  }

  resolveModel(
    operation: AudioModelOperation,
    requested?: ModelRef,
  ): AudioModel | undefined {
    const catalog = this.catalog().models.filter((model) =>
      model.capabilities.operations.includes(operation),
    );
    return requested
      ? catalog.find((model) => sameModel(model, requested))
      : catalog[0];
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    const model = this.resolveModel(input.operation, input.model);
    if (!model) {
      if (input.model)
        throw new AudioGenerationError(
          "The selected audio model is unavailable or does not support this operation",
          400,
        );
      throw new AudioGenerationError(
        `No ${operationName(input.operation)} model is available. Connect an audio provider first.`,
        503,
      );
    }
    const adapter = this.adapters.find(
      (candidate) => candidate.id === model.provider,
    );
    if (!adapter)
      throw new AudioGenerationError(
        "The selected audio provider is unavailable",
        503,
      );
    return adapter.generate(
      { ...input, model: { provider: model.provider, id: model.id } },
      signal,
    );
  }

  /** One page of a provider's account voices. */
  async voices(provider: string, query: { search?: string; pageToken?: string }, signal?: AbortSignal): Promise<AudioVoicePage> {
    const adapter = this.adapters.find((candidate) => candidate.id === provider);
    if (!adapter?.voices) throw new AudioGenerationError("This audio provider has no voice list", 404);
    if (!adapter.enabled()) throw new AudioGenerationError(`${adapter.name} is disabled`, 503);
    if (!adapter.configured()) throw new AudioGenerationError(`Connect ${adapter.name} before listing its voices`, 503);
    return adapter.voices(query, signal);
  }

  /** Transcribes with the requested model, or the first ready one that can. */
  async transcribe(input: AudioTranscriptionRequest, signal?: AbortSignal): Promise<AudioTranscription> {
    const model = this.resolveModel("transcription", input.model);
    if (!model) {
      throw input.model
        ? new AudioGenerationError("The selected transcription model is unavailable", 400)
        : new AudioGenerationError("No transcription model is available. Connect an audio provider that transcribes speech first.", 503);
    }
    const adapter = this.adapters.find((candidate) => candidate.id === model.provider);
    if (!adapter?.transcribe) throw new AudioGenerationError("The selected audio provider cannot transcribe", 503);
    return adapter.transcribe({ ...input, model: { provider: model.provider, id: model.id } }, signal);
  }
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function operationName(operation: AudioGenerationRequest["operation"]): string {
  if (operation === "sound-effect") return "sound effect";
  return operation;
}
