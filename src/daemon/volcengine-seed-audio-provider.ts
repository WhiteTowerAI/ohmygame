import { randomUUID } from "node:crypto";
import {
  AUDIO_VOICE_ID_PATTERN,
  DOUBAO_SEED_AUDIO_PROVIDER_NAME,
  type AudioGenerationRequest,
  type AudioModel,
  type GeneratedAudio,
} from "../shared/audio.js";
import {
  AudioGenerationError,
  type AudioProviderAdapter,
} from "./audio-generation.js";
import {
  audioRequestSignal,
  decodeAudioBase64,
  doubaoErrorStatus,
  inspectAudio,
  readAudioJson,
  audioHttpError,
  validateControl,
} from "./audio-media.js";

const DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/create";
const PROVIDER_ID = "volcengine-seed-audio";
const MODEL_ID = "seed-audio-1.0";
const MAX_PROMPT_CHARACTERS = 3000;
// A fixed public budget leaves room for the operation and timing instructions.
const INSTRUCTION_BUDGET = 256;
const SAMPLE_RATES = [8000, 16000, 24000, 32000, 40000, 44100, 48000] as const;
export const VOLCENGINE_SEED_AUDIO_MODELS: readonly AudioModel[] = [
  {
    provider: PROVIDER_ID,
    providerName: DOUBAO_SEED_AUDIO_PROVIDER_NAME,
    id: MODEL_ID,
    name: "Seed Audio 1.0",
    protocol: "volcengine-seed-audio-v3",
    capabilities: {
      operations: ["speech", "sound-effect", "music", "audio-scene"],
      executionModes: ["synchronous"],
      languages: [
        "zh-cn",
        "en",
        "ja",
        "ko",
        "es-mx",
        "es-es",
        "de",
        "fr",
        "pt-br",
        "th",
        "vi",
        "ms",
        "fil",
        "it",
        "ru",
        "nl",
        "pl",
        "tr",
      ],
      formats: ["mp3", "wav", "ogg_opus"],
      sampleRatesByFormat: {
        wav: [...SAMPLE_RATES],
        mp3: [8000, 16000, 24000, 32000, 44100, 48000],
        ogg_opus: [48000],
      },
      maxTextCharacters: MAX_PROMPT_CHARACTERS - INSTRUCTION_BUDGET,
      promptInstructionCharacters: INSTRUCTION_BUDGET,
      maxDurationSeconds: 120,
      supportsLoop: false,
      supportsLyrics: false,
      supportsInstrumental: false,
      supportsVocalToggle: false,
      supportsSpeaker: true,
      supportsPitch: true,
      supportsVolume: true,
      supportsStyle: true,
      supportsNegativePrompt: false,
    },
  },
];

export class VolcengineSeedAudioProvider implements AudioProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly name = DOUBAO_SEED_AUDIO_PROVIDER_NAME;
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly baseUrl = DEFAULT_ENDPOINT,
    private readonly isEnabled: () => boolean = () => true,
  ) {}
  configured() {
    return Boolean(this.apiKey());
  }
  enabled() {
    return this.isEnabled();
  }
  models(): AudioModel[] {
    return VOLCENGINE_SEED_AUDIO_MODELS.map((model) => structuredClone(model));
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    if (input.operation === "dialogue")
      throw new AudioGenerationError(
        "Use audio-scene for prompted dialogue",
        400,
      );
    const model = VOLCENGINE_SEED_AUDIO_MODELS[0]!,
      caps = model.capabilities;
    if (input.model?.provider !== PROVIDER_ID || input.model.id !== MODEL_ID)
      throw new AudioGenerationError(
        "The selected Seed Audio model is unavailable",
        400,
      );
    const key = this.apiKey();
    if (!key)
      throw new AudioGenerationError(`${this.name} is not connected`, 503);
    const prompt = input.operation === "speech" ? input.text : input.prompt;
    if (!prompt?.trim())
      throw new AudioGenerationError("Audio prompt must not be empty", 400);
    if (prompt.length > caps.maxTextCharacters!)
      throw new AudioGenerationError(
        `Seed Audio prompt must be ${caps.maxTextCharacters} characters or fewer, including linked text`,
        400,
      );
    if (
      "durationSeconds" in input &&
      input.durationSeconds !== undefined &&
      (!Number.isFinite(input.durationSeconds) ||
        input.durationSeconds <= 0 ||
        input.durationSeconds > caps.maxDurationSeconds!)
    )
      throw new AudioGenerationError(
        `Seed Audio target duration must be greater than 0 and no more than ${caps.maxDurationSeconds} seconds`,
        400,
      );
    if ("loop" in input && input.loop)
      throw new AudioGenerationError(
        "Seed Audio does not create guaranteed seamless loops",
        400,
      );
    if (input.operation === "sound-effect" && input.negativePrompt?.trim())
      throw new AudioGenerationError(
        "Seed Audio does not support negative prompts",
        400,
      );
    if (
      input.operation === "music" &&
      (!input.instrumental || input.lyrics?.trim())
    )
      throw new AudioGenerationError(
        "The music tool supports instrumental music only; use audio-scene for voice and scene prompts",
        400,
      );
    if (input.output?.channels !== undefined)
      throw new AudioGenerationError(
        "Seed Audio does not expose channel selection",
        400,
      );
    if (
      input.ssml ||
      input.pronunciation?.length ||
      input.dialect ||
      input.autoLanguage ||
      input.silenceMs ||
      input.sectionId ||
      input.voiceModel ||
      input.output?.bitRate
    )
      throw new AudioGenerationError(
        "The selected Seed Audio model does not support these TTS-specific options",
        400,
      );
    validateControl(input.speed, -50, 100, "Speech rate");
    validateControl(input.pitch, -12, 12, "Pitch");
    validateControl(input.volume, -50, 100, "Volume");
    const format = input.output?.format ?? "mp3",
      sampleRate = input.output?.sampleRate ?? 48000;
    if (!caps.sampleRatesByFormat?.[format]?.includes(sampleRate))
      throw new AudioGenerationError(
        "Unsupported Seed Audio format or sample rate",
        400,
      );
    if (
      input.voiceId &&
      !new RegExp(AUDIO_VOICE_ID_PATTERN).test(input.voiceId)
    )
      throw new AudioGenerationError("Invalid Speaker ID", 400);
    let textPrompt = prompt.trim();
    const duration =
      "durationSeconds" in input && input.durationSeconds !== undefined
        ? ` approximately ${input.durationSeconds} seconds long`
        : "";
    const instruction =
      input.operation === "sound-effect"
        ? `Create a standalone game sound effect${duration}. Do not include speech, narration, singing, or background music. Description: `
        : input.operation === "music"
          ? `Create instrumental game background music${duration}. Do not include vocals, speech, narration, or lyrics. Description: `
          : input.operation === "speech"
            ? "Speak the following text exactly. "
            : duration
              ? `Create audio${duration}. `
              : "";
    textPrompt = `${instruction}${input.language ? `Language: ${input.language}. ` : ""}${input.style?.trim() ? `Delivery: ${input.style.trim()}. ` : ""}${textPrompt}`;
    if (textPrompt.length > MAX_PROMPT_CHARACTERS)
      throw new AudioGenerationError(
        "The combined prompt, style and instructions exceed 3000 characters",
        400,
      );
    const requestId = randomUUID(),
      requestSignal = audioRequestSignal(signal);
    try {
      const response = await this.request(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": key,
          "X-Api-Request-Id": requestId,
        },
        signal: requestSignal,
        body: JSON.stringify({
          model: MODEL_ID,
          text_prompt: textPrompt,
          ...(input.voiceId ? { references: [{ speaker: input.voiceId }] } : {}),
          audio_config: {
            format,
            sample_rate: sampleRate,
            pitch_rate: input.pitch ?? 0,
            speech_rate: input.speed ?? 0,
            loudness_rate: input.volume ?? 0,
          },
          watermark: { aigc_watermark: false, aigc_metadata: { enable: true } },
        }),
      });
      if (!response.ok) throw await audioHttpError(response, this.name);
      const result = await readAudioJson(response);
      const code = Number(result.code ?? 0);
      if (code !== 0 && code !== 20000000) {
        const message =
          typeof result.message === "string"
            ? result.message
            : `Seed Audio request failed with code ${code}`;
        throw new AudioGenerationError(
          message,
          doubaoErrorStatus(code, message),
        );
      }
      if (typeof result.audio !== "string")
        throw new AudioGenerationError("Seed Audio returned no audio", 502);
      const bytes = decodeAudioBase64(result.audio);
      const info = await inspectAudio(bytes, format, 502);
      return {
        bytes,
        mediaType:
          format === "wav"
            ? "audio/wav"
            : format === "ogg_opus"
              ? "audio/ogg"
              : "audio/mpeg",
        model: { provider: PROVIDER_ID, id: MODEL_ID },
        metadata: {
          durationMs:
            typeof result.duration === "number" &&
            Number.isFinite(result.duration) &&
            result.duration >= 0
              ? Math.round(result.duration * 1000)
              : info.durationMs,
          ...(typeof result.original_duration === "number" &&
          Number.isFinite(result.original_duration) &&
          result.original_duration >= 0
            ? {
                originalDurationMs: Math.round(result.original_duration * 1000),
              }
            : {}),
          sampleRate: info.sampleRate,
          channels: info.channels,
          codec: format,
          providerRequestId: response.headers.get("x-tt-logid") ?? requestId,
        },
      };
    } catch (cause) {
      if (signal?.aborted) throw cause;
      if (cause instanceof AudioGenerationError) throw cause;
      throw new AudioGenerationError(
        requestSignal.aborted
          ? "Audio generation timed out after five minutes"
          : `Could not complete Seed Audio generation: ${cause instanceof Error ? cause.message : String(cause)}`,
        502,
      );
    }
  }
}
