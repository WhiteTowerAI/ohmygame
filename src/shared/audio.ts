import type { AssetCanvasReference, ModelRef } from "./contracts.js";
import { VOLCENGINE_TTS_VOICES } from "./doubao-voices.js";

export const AUDIO_OPERATIONS = [
  "speech",
  "dialogue",
  "sound-effect",
  "music",
  "audio-scene",
] as const;
export type AudioOperation = (typeof AUDIO_OPERATIONS)[number];

export const AUDIO_OUTPUT_FORMATS = ["mp3", "wav", "ogg_opus"] as const;
export type AudioOutputFormat = (typeof AUDIO_OUTPUT_FORMATS)[number];

export const AUDIO_VOICE_ID_MAX_LENGTH = 256;
export const AUDIO_VOICE_ID_PATTERN = "^[A-Za-z0-9_-]+$";
export const DOUBAO_SPEECH_PROVIDER_NAME = "Doubao Speech";
export const DOUBAO_SEED_AUDIO_PROVIDER_NAME = "Doubao Seed Audio";
/** Settings show both Doubao services as one connection. */
export const DOUBAO_VOICE_PROVIDER_NAME = "Doubao Voice";
export const AUDIO_REFERENCE_ID_PATTERN = "^(Audio|Image)[1-9][0-9]*$";

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
  subtitles?: boolean;
  ssml?: string;
  pronunciation?: Array<{ word: string; replacement: string }>;
  silenceMs?: number;
  sectionId?: string;
  output?: AudioOutputSettings;
}

/** Stable UI aliases are compiled to the provider's ordered references at submission. */
export interface AudioReference {
  id: string;
  type: "audio" | "image";
  assetId: string;
}
export interface AudioCanvasReference extends Omit<AudioReference, "assetId"> {
  source: AssetCanvasReference;
}
export interface AudioCanvasSettings extends AudioSettings {
  audioReferences?: AudioCanvasReference[];
  audioReferenceSerial?: number;
}
export interface AudioReferenceData extends AudioReference {
  bytes: Uint8Array;
  mediaType: string;
}
export interface SpeechAudioRequest extends AudioSettings {
  operation: "speech";
  text: string;
  model?: ModelRef;
  references?: AudioReference[];
}

export interface DialogueAudioRequest {
  operation: "dialogue";
  model?: ModelRef;
  turns: Array<{
    speaker: string;
    voiceId: string;
    text: string;
    style?: string;
  }>;
  output?: AudioOutputSettings;
}

export interface SoundEffectAudioRequest extends AudioSettings {
  references?: AudioReference[];
  operation: "sound-effect";
  model?: ModelRef;
  prompt: string;
  durationSeconds?: number;
  loop?: boolean;
  negativePrompt?: string;
  output?: AudioOutputSettings;
}

export interface MusicAudioRequest extends AudioSettings {
  references?: AudioReference[];
  operation: "music";
  model?: ModelRef;
  prompt: string;
  instrumental: boolean;
  lyrics?: string;
  durationSeconds?: number;
  loop?: boolean;
  referenceAssetId?: string;
  output?: AudioOutputSettings;
}

export interface SceneAudioRequest extends AudioSettings {
  operation: "audio-scene";
  model?: ModelRef;
  prompt: string;
  durationSeconds?: number;
  references?: AudioReference[];
}

export type AudioGenerationRequest =
  | SpeechAudioRequest
  | DialogueAudioRequest
  | SoundEffectAudioRequest
  | MusicAudioRequest
  | SceneAudioRequest;

export interface AudioModelCapabilities {
  operations: AudioOperation[];
  executionModes: Array<"synchronous" | "streaming" | "async-task">;
  languages?: string[];
  formats: AudioOutputFormat[];
  sampleRates?: AudioSampleRate[];
  maxTextCharacters?: number;
  maxDurationSeconds?: number;
  maxSpeakers?: number;
  supportsSSML?: boolean;
  supportsVoiceClone?: boolean;
  supportsVoiceDesign?: boolean;
  supportsAlignment?: boolean;
  supportsLoop?: boolean;
  supportsLyrics?: boolean;
  supportsInstrumental?: boolean;
  supportsReferenceAudio?: boolean;
  supportsNegativePrompt?: boolean;
  supportsReferenceImage?: boolean;
  supportsSpeaker?: boolean;
  supportsPitch?: boolean;
  supportsVolume?: boolean;
  supportsStyle?: boolean;
  supportsVocalToggle?: boolean;
  subtitleLanguages?: string[];
  sampleRatesByFormat?: Partial<Record<AudioOutputFormat, AudioSampleRate[]>>;
  maxReferenceAudio?: number;
  maxReferenceImages?: number;
  maxReferenceBytes?: number;
  maxReferenceSeconds?: number;
  /** Images cannot be combined with audio references or a Speaker ID; a Speaker ID counts toward maxReferenceAudio. */
  referenceModesExclusive?: boolean;
  promptInstructionCharacters?: number;
  /** Text-to-speech request options: pronunciation, language detection, dialect, silence, section, bit rate and cloned voice models. */
  supportsSpeechOptions?: boolean;
}

export interface AudioModel extends ModelRef {
  name: string;
  providerName: string;
  protocol: string;
  capabilities: AudioModelCapabilities;
}

export function availableAudioOperations(models: readonly AudioModel[]): Set<AudioOperation> {
  return new Set(models.flatMap((model) => model.capabilities.operations));
}

export interface AudioProviderCatalogStatus {
  provider: string;
  name: string;
  configured: boolean;
  state: "ready" | "not_configured" | "disabled" | "error";
  message?: string;
  defaultVoiceId?: string;
}

export interface AudioModelCatalog {
  models: AudioModel[];
  providers: AudioProviderCatalogStatus[];
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

export interface AudioWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}
export interface AudioSentence extends AudioWord { words?: AudioWord[] }
export interface AudioSubtitles { text: string; sentences: AudioSentence[] }
export interface AudioAssetData {
  metadata?: AudioMetadata;
  subtitles?: AudioSubtitles;
  request?: AudioGenerationRequest;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  mediaType: "audio/mpeg" | "audio/wav" | "audio/ogg";
  model: ModelRef;
  metadata?: AudioMetadata;
  subtitles?: AudioSubtitles;
}

export interface RunSpeechToolRequest extends Omit<
  SpeechAudioRequest,
  "operation"
> {}
export interface RunSoundEffectToolRequest extends Omit<
  SoundEffectAudioRequest,
  "operation"
> {}
export interface RunMusicToolRequest extends Omit<
  MusicAudioRequest,
  "operation"
> {}

export interface RunSceneAudioToolRequest extends Omit<SceneAudioRequest, "operation"> {}

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

export function resolveAudioMentions(prompt: string, references: readonly Pick<AudioReference, "id" | "type">[]): string {
  return prompt.replace(/@Audio([1-9][0-9]*)(?![\w])/g, (_, number: string) => {
    const index = references.filter((reference) => reference.type === "audio").findIndex((reference) => reference.id === `Audio${number}`);
    if (index < 0) throw new Error(`@Audio${number} refers to missing reference audio. Remove the mention or restore the reference.`);
    return `@音频${index + 1}`;
  });
}

export function audioSubtitleFile(subtitles: AudioSubtitles, format: "srt" | "vtt"): string {
  const time = (ms: number) => {
    const value = Math.max(0, Math.round(ms));
    return `${String(Math.floor(value / 3600000)).padStart(2, "0")}:${String(Math.floor(value / 60000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(value % 1000).padStart(3, "0")}`;
  };
  return (format === "vtt" ? "WEBVTT\n\n" : "") + subtitles.sentences.map((sentence, index) =>
    `${format === "srt" ? `${index + 1}\n` : ""}${time(sentence.startMs)} --> ${time(sentence.endMs)}\n${sentence.text.replace(/-->/g, "→").replace(/\r?\n/g, " ")}\n`,
  ).join("\n");
}

export const AUDIO_SETTING_KEYS = ["voiceId", "voiceKind", "voiceModel", "language", "autoLanguage", "dialect", "style", "speed", "pitch", "volume", "subtitles", "ssml", "pronunciation", "silenceMs", "sectionId", "output"] as const;
export function audioSettings(data: AudioSettings): AudioSettings {
  return Object.fromEntries(AUDIO_SETTING_KEYS.flatMap((key) => data[key] !== undefined ? [[key, data[key]]] : [])) as AudioSettings;
}
export function audioCanvasSettings(data: AudioCanvasSettings): AudioCanvasSettings {
  return { ...audioSettings(data), ...(data.audioReferenceSerial !== undefined ? { audioReferenceSerial: data.audioReferenceSerial } : {}), ...(data.audioReferences ? { audioReferences: data.audioReferences } : {}) };
}
export function isAudioNodeType(type: string): type is "speech" | "sound-effect" | "music" | "audio-scene" {
  return ["speech", "sound-effect", "music", "audio-scene"].includes(type);
}

export function audioCompanionFiles(name: string, data: AudioAssetData): Array<{ name: string; mediaType: string; role: "metadata" | "subtitles"; text: string }> {
  return [
    { name: `${name}.audio.json`, mediaType: "application/json", role: "metadata", text: `${JSON.stringify(data, null, 2)}\n` },
    ...(data.subtitles ? (["srt", "vtt"] as const).map((format) => ({ name: `${name}.${format}`, mediaType: format === "srt" ? "application/x-subrip" : "text/vtt", role: "subtitles" as const, text: audioSubtitleFile(data.subtitles!, format) })) : []),
  ];
}
