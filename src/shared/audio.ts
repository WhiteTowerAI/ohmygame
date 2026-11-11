import type { ModelRef } from "./contracts.js";
import { VOLCENGINE_TTS_VOICES } from "./doubao-voices.js";

/** What a model's audio is for. It describes the model and picks one when a request names none; requests don't carry it otherwise. */
export const AUDIO_KINDS = ["speech", "sound-effect", "music"] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

export const AUDIO_OUTPUT_FORMATS = ["mp3", "wav", "ogg_opus"] as const;
export type AudioOutputFormat = (typeof AUDIO_OUTPUT_FORMATS)[number];

export const AUDIO_VOICE_ID_MAX_LENGTH = 256;
/** The longest prompt an audio node or tool takes; each model sets its own, usually lower, `maxTextCharacters`. */
export const AUDIO_PROMPT_MAX_LENGTH = 32_000;
export const AUDIO_VOICE_ID_PATTERN = "^[A-Za-z0-9_-]+$";
/** Doubao Speech is one provider; the ID is its speech service's, from before Seed Audio joined it, so saved choices still match. */
export const DOUBAO_SPEECH_PROVIDER_ID = "volcengine-tts";
export const DOUBAO_SPEECH_PROVIDER_NAME = "Doubao Speech";

export const AUDIO_SAMPLE_RATES = [
  8_000, 16_000, 22_050, 24_000, 32_000, 40_000, 44_100, 48_000,
] as const;
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATES)[number];

export interface AudioOutputSettings {
  format?: AudioOutputFormat;
  sampleRate?: AudioSampleRate;
  channels?: 1 | 2;
  bitRate?: number;
}

export interface AudioSettings {
  voiceId?: string;
  voiceKind?: "preset" | "cloned";
  voiceModel?: "standard" | "expressive";
  language?: string;
  autoLanguage?: boolean;
  dialect?: string;
  style?: string;
  speed?: number;
  pitch?: number;
  volume?: number;
  ssml?: string;
  pronunciation?: Array<{ word: string; replacement: string }>;
  silenceMs?: number;
  sectionId?: string;
  output?: AudioOutputSettings;
}

/** One request for every audio model; the model decides what the prompt means and which options apply. */
export interface AudioGenerationRequest extends AudioSettings {
  model?: ModelRef;
  /** The words a model that reads text speaks exactly, or a description of the audio for the rest. */
  prompt: string;
  /** Picks a model that makes this kind of audio when `model` is absent. */
  kind?: AudioKind;
  durationSeconds?: number;
  loop?: boolean;
  /** Music without vocals, for models that set `supportsInstrumental`. */
  instrumental?: boolean;
}

export interface AudioModelCapabilities {
  /** The kinds of audio it makes; empty for a model that only transcribes. */
  produces: AudioKind[];
  /** Speaks the prompt word for word, with a voice, rather than following a description. */
  readsText?: boolean;
  /** Turns audio into text. */
  transcribes?: boolean;
  languages?: string[];
  formats: AudioOutputFormat[];
  sampleRates?: AudioSampleRate[];
  maxTextCharacters?: number;
  maxDurationSeconds?: number;
  supportsSSML?: boolean;
  supportsLoop?: boolean;
  supportsInstrumental?: boolean;
  supportsSpeaker?: boolean;
  supportsPitch?: boolean;
  supportsVolume?: boolean;
  supportsStyle?: boolean;
  sampleRatesByFormat?: Partial<Record<AudioOutputFormat, AudioSampleRate[]>>;
  /** Text-to-speech request options: pronunciation, language detection, dialect, silence, section, bit rate and cloned voice models. */
  supportsSpeechOptions?: boolean;
  /** The speech rate this model accepts, in the shared -50…100 scale; the full scale when unset. */
  speedRange?: readonly [number, number];
  /** Speech needs a voice picked from the provider's own list; there is no default. */
  requiresVoice?: boolean;
  /** Shortest and longest audio this model makes, in seconds. */
  minDurationSeconds?: number;
}

/** A voice a provider offers, listed from its account rather than built in. */
export interface AudioVoice {
  id: string;
  name: string;
  /** A hosted sample; playing it spends no generation quota. */
  previewUrl?: string;
  labels?: Record<string, string>;
}

export interface AudioVoicePage {
  voices: AudioVoice[];
  /** Pass back to read the next page; absent on the last one. */
  nextPageToken?: string;
}

export interface AudioTranscriptionRequest {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
  /** ISO 639-1 or 639-3; the provider detects it when absent. */
  language?: string;
  model?: ModelRef;
}

export interface AudioTranscription {
  text: string;
  language?: string;
  model: ModelRef;
}

export interface AudioModel extends ModelRef {
  name: string;
  providerName: string;
  protocol: string;
  capabilities: AudioModelCapabilities;
}

export interface AudioProviderCatalogStatus {
  provider: string;
  name: string;
  configured: boolean;
  state: "ready" | "not_configured" | "disabled" | "error";
  message?: string;
  defaultVoiceId?: string;
  /** Its voices are listed from the account, through `/audio-providers/:provider/voices`. */
  listsVoices?: boolean;
}

export interface AudioModelCatalog {
  models: AudioModel[];
  providers: AudioProviderCatalogStatus[];
  /** The global default for each kind; the agent and new audio nodes use it when no model is named. */
  defaultModels?: Partial<Record<AudioKind, ModelRef>>;
}

export interface AudioMetadata {
  durationMs?: number;
  originalDurationMs?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  providerRequestId?: string;
  usageCharacters?: number;
}

/** Assets made before beta.5.0 may also hold `subtitles`, which nothing reads. */
export interface AudioAssetData {
  metadata?: AudioMetadata;
  /** What was sent. Assets made before beta.5.6 hold the older per-operation shape, with `operation` and, for speech, `text`. */
  request?: AudioGenerationRequest;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  mediaType: "audio/mpeg" | "audio/wav" | "audio/ogg";
  model: ModelRef;
  metadata?: AudioMetadata;
}

export interface VolcengineTtsVoice {
  id: string;
  name: string;
  gender: "female" | "male";
  /** Primary language as an explicit_language code. */
  language: string;
  /** Accepts explicit_dialect. */
  dialects?: true;
  /** Ignores context_texts voice instructions. */
  noInstructions?: true;
  /** Official sample from ListSpeakers; playing it costs no synthesis quota. */
  trialUrl?: string;
}

export { VOLCENGINE_TTS_VOICES };
export function findVolcengineTtsVoice(id: string | undefined): VolcengineTtsVoice | undefined {
  return id ? VOLCENGINE_TTS_VOICES.find((voice) => voice.id === id) : undefined;
}

/** explicit_dialect values for voices marked with `dialects`. */
export const DOUBAO_TTS_DIALECTS = ["beijing", "dongbei", "henan", "shaanxi", "shanghai", "sichuan", "tianjin", "yue"] as const;

export function audioExtension(mediaType: string): "mp3" | "wav" | "ogg" {
  return mediaType === "audio/wav" ? "wav" : mediaType === "audio/ogg" ? "ogg" : "mp3";
}

export const AUDIO_SETTING_KEYS = ["voiceId", "voiceKind", "voiceModel", "language", "autoLanguage", "dialect", "style", "speed", "pitch", "volume", "ssml", "pronunciation", "silenceMs", "sectionId", "output"] as const;
export function audioSettings(data: AudioSettings): AudioSettings {
  return Object.fromEntries(AUDIO_SETTING_KEYS.flatMap((key) => data[key] !== undefined ? [[key, data[key]]] : [])) as AudioSettings;
}
export function audioCompanionFiles(name: string, data: AudioAssetData): Array<{ name: string; mediaType: string; role: "metadata"; text: string }> {
  const metadata = {
    ...(data.metadata ? { metadata: data.metadata } : {}),
    ...(data.request ? { request: data.request } : {}),
  };
  return [{ name: `${name}.audio.json`, mediaType: "application/json", role: "metadata", text: `${JSON.stringify(metadata, null, 2)}\n` }];
}
