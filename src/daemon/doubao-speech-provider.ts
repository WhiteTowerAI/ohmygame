import {
  DOUBAO_SPEECH_PROVIDER_ID,
  DOUBAO_SPEECH_PROVIDER_NAME,
  type AudioGenerationRequest,
  type AudioModel,
  type GeneratedAudio,
} from "../shared/audio.js";
import type { AudioProviderAdapter } from "./audio-generation.js";
import type { DoubaoService } from "./doubao-voice-settings.js";
import { SEED_AUDIO_MODEL_ID, VolcengineSeedAudioProvider } from "./volcengine-seed-audio-provider.js";
import { VolcengineTtsProvider } from "./volcengine-tts-provider.js";

export interface DoubaoSpeechOptions {
  /** The key for one service; both read the same key unless older per-service keys are still saved. */
  key(service: DoubaoService): string | undefined;
  defaultVoiceId(): string | undefined;
  enabled(): boolean;
  request?: typeof fetch;
}

/**
 * Doubao Speech: one provider with one key and one switch, offering speech synthesis (TTS 2.0)
 * and Seed Audio. They are separate APIs of the same Volcengine product, so each model calls its own.
 */
export class DoubaoSpeechProvider implements AudioProviderAdapter {
  readonly id = DOUBAO_SPEECH_PROVIDER_ID;
  readonly name = DOUBAO_SPEECH_PROVIDER_NAME;
  readonly #speech: VolcengineTtsProvider;
  readonly #seed: VolcengineSeedAudioProvider;

  constructor(private readonly options: DoubaoSpeechOptions) {
    this.#speech = new VolcengineTtsProvider(() => options.key("volcengine-tts"), options.request, undefined, undefined, options.defaultVoiceId);
    this.#seed = new VolcengineSeedAudioProvider(() => options.key("volcengine-seed-audio"), options.request);
  }

  defaultVoiceId(): string | undefined {
    return this.options.defaultVoiceId();
  }
  configured(): boolean {
    return this.#speech.configured() || this.#seed.configured();
  }
  enabled(): boolean {
    return this.options.enabled();
  }
  /** Models of the services that have a key. */
  models(): AudioModel[] {
    return [this.#speech, this.#seed].filter((service) => service.configured()).flatMap((service) => service.models());
  }
  generate(input: AudioGenerationRequest, signal?: AbortSignal): Promise<GeneratedAudio> {
    return input.model?.id === SEED_AUDIO_MODEL_ID ? this.#seed.generate(input, signal) : this.#speech.generate(input, signal);
  }
}
