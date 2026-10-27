import { randomUUID } from "node:crypto";
import {
  AUDIO_VOICE_ID_PATTERN,
  DOUBAO_SEED_AUDIO_PROVIDER_NAME,
  resolveAudioMentions,
  type AudioGenerationRequest,
  type AudioModel,
  type AudioReferenceData,
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
  seedSubtitles,
  audioHttpError,
  validateControl,
} from "./audio-media.js";
import { sniffImageType } from "./image-format.js";

const DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/create";
const PROVIDER_ID = "volcengine-seed-audio";
const MODEL_ID = "seed-audio-1.0";
const MAX_PROMPT_CHARACTERS = 3000;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
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
      supportsReferenceAudio: true,
      supportsReferenceImage: true,
      supportsSpeaker: true,
      supportsPitch: true,
      supportsVolume: true,
      supportsAlignment: true,
      supportsStyle: true,
      maxReferenceAudio: 3,
      maxReferenceImages: 1,
      maxReferenceBytes: MAX_REFERENCE_BYTES,
      maxReferenceSeconds: 30,
      referenceModesExclusive: true,
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
    references: readonly AudioReferenceData[] = [],
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
    const requested = input.references ?? [];
    if (
      new Set(requested.map((reference) => reference.id)).size !==
        requested.length ||
      requested.length !== references.length ||
      requested.some(
        (reference, i) =>
          reference.assetId !== references[i]?.assetId ||
          reference.id !== references[i]?.id ||
          reference.type !== references[i]?.type,
      )
    )
      throw new AudioGenerationError(
        "Invalid or unresolved audio references",
        400,
      );
    const images = references.filter((reference) => reference.type === "image"),
      audios = references.filter((reference) => reference.type === "audio");
    // A Speaker ID is sent as one more audio-side reference; images stand alone.
    if (
      images.length > caps.maxReferenceImages! ||
      audios.length + (input.voiceId ? 1 : 0) > caps.maxReferenceAudio! ||
      (images.length && (audios.length || input.voiceId))
    )
      throw new AudioGenerationError(
        `Use one image, or up to ${caps.maxReferenceAudio} audio references including an optional Speaker ID`,
        400,
      );
    const providerReferences: Array<{
      image_data?: string;
      audio_data?: string;
      speaker?: string;
    }> = await Promise.all(
      references.map(async (reference) => {
        if (
          !reference.bytes.length ||
          reference.bytes.length > caps.maxReferenceBytes!
        )
          throw new AudioGenerationError(
            `Each reference must be no more than ${caps.maxReferenceBytes! / 1024 / 1024} MB`,
            400,
          );
        if (reference.type === "image") {
          if (
            !["image/png", "image/jpeg", "image/webp"].includes(
              sniffImageType(Buffer.from(reference.bytes)) ?? "",
            )
          )
            throw new AudioGenerationError(
              "Seed Audio requires a PNG, JPEG or WebP image",
              400,
            );
          return {
            image_data: Buffer.from(reference.bytes).toString("base64"),
          };
        }
        const info = await inspectAudio(reference.bytes);
        if (!(
          info.mime.includes("wav") ||
          info.codec === "mp3" ||
          (info.mime.includes("ogg") && info.codec === "opus")
        ))
          throw new AudioGenerationError(
            "Reference audio must be WAV, MP3 or Ogg Opus; convert this file first",
            400,
          );
        if (info.durationMs > caps.maxReferenceSeconds! * 1000)
          throw new AudioGenerationError(
            `Reference audio must be ${caps.maxReferenceSeconds} seconds or shorter; select a shorter clip`,
            400,
          );
        return { audio_data: Buffer.from(reference.bytes).toString("base64") };
      }),
    );
    if (input.voiceId) providerReferences.push({ speaker: input.voiceId });
    let textPrompt: string;
    try {
      textPrompt = resolveAudioMentions(prompt.trim(), requested);
    } catch (cause) {
      throw new AudioGenerationError((cause as Error).message, 400);
    }
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
          ...(providerReferences.length
            ? { references: providerReferences }
            : {}),
          audio_config: {
            format,
            sample_rate: sampleRate,
            pitch_rate: input.pitch ?? 0,
            speech_rate: input.speed ?? 0,
            loudness_rate: input.volume ?? 0,
            enable_subtitle: input.subtitles ?? false,
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
      const subtitles = input.subtitles
        ? seedSubtitles(result.subtitle)
        : undefined;
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
        ...(subtitles ? { subtitles } : {}),
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
