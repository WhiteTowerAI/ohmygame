import { randomUUID } from "node:crypto";
import {
  DOUBAO_SEED_AUDIO_PROVIDER_NAME,
  type AudioGenerationRequest,
  type AudioModel,
  type GeneratedAudio,
  type MusicAudioRequest,
  type SoundEffectAudioRequest,
} from "../shared/audio.js";
import {
  AudioGenerationError,
  type AudioProviderAdapter,
} from "./audio-generation.js";

const DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/create";
const PROVIDER_ID = "volcengine-seed-audio";
const MODEL_ID = "seed-audio-1.0";
const MAX_PROMPT_CHARACTERS = 3_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const SAMPLE_RATES = [8_000, 16_000, 24_000, 48_000] as const;

export const VOLCENGINE_SEED_AUDIO_MODELS: readonly AudioModel[] = [
  {
    provider: PROVIDER_ID,
    providerName: DOUBAO_SEED_AUDIO_PROVIDER_NAME,
    id: MODEL_ID,
    name: "Seed Audio 1.0",
    protocol: "volcengine-seed-audio-v3",
    capabilities: {
      operations: ["sound-effect", "music"],
      executionModes: ["synchronous"],
      languages: ["zh-cn", "en"],
      formats: ["mp3", "wav"],
      sampleRates: [...SAMPLE_RATES],
      maxTextCharacters: MAX_PROMPT_CHARACTERS,
      maxDurationSeconds: 120,
      supportsLoop: false,
      supportsLyrics: false,
      supportsInstrumental: false,
      supportsReferenceAudio: false,
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

  configured(): boolean {
    return Boolean(this.apiKey());
  }

  enabled(): boolean {
    return this.isEnabled();
  }

  models(): AudioModel[] {
    return VOLCENGINE_SEED_AUDIO_MODELS.map((model) => structuredClone(model));
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    if (input.operation !== "sound-effect" && input.operation !== "music")
      throw new AudioGenerationError(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} supports sound effects and instrumental music only`,
        400,
      );
    const model = VOLCENGINE_SEED_AUDIO_MODELS.find(
      (entry) => entry.id === input.model?.id,
    );
    if (!model || input.model?.provider !== PROVIDER_ID)
      throw new AudioGenerationError(
        `The selected ${DOUBAO_SEED_AUDIO_PROVIDER_NAME} model is unavailable`,
        400,
      );
    const key = this.apiKey();
    if (!key)
      throw new AudioGenerationError(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} is not connected`,
        503,
      );

    validateRequest(input);
    const requestId = randomUUID();
    const format = input.output?.format ?? "mp3";
    const sampleRate = input.output?.sampleRate ?? 48_000;
    const textPrompt = providerPrompt(input);
    if (textPrompt.length > MAX_PROMPT_CHARACTERS)
      throw new AudioGenerationError(
        `Seed Audio prompt must be ${MAX_PROMPT_CHARACTERS.toLocaleString("en-US")} characters or fewer after instructions are added`,
        400,
      );

    let response: Response;
    try {
      response = await this.request(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": key,
          "X-Api-Request-Id": requestId,
        },
        body: JSON.stringify({
          model: MODEL_ID,
          text_prompt: textPrompt,
          audio_config: {
            format,
            sample_rate: sampleRate,
            pitch_rate: 0,
            speech_rate: 0,
            loudness_rate: 0,
            enable_subtitle: false,
          },
          watermark: { aigc_watermark: false, aigc_metadata: { enable: true } },
        }),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(
        `Could not reach ${DOUBAO_SEED_AUDIO_PROVIDER_NAME}: ${cause instanceof Error ? cause.message : String(cause)}`,
        502,
      );
    }
    if (!response.ok) throw await responseError(response);
    const result = await parseResponse(response);
    const bytes = decodeAudio(result.audio);
    validateAudio(bytes, format);
    const duration = finiteDuration(result.duration);
    return {
      bytes,
      mediaType: format === "wav" ? "audio/wav" : "audio/mpeg",
      model: { provider: PROVIDER_ID, id: MODEL_ID },
      metadata: {
        ...(duration !== undefined
          ? { durationMs: Math.round(duration * 1_000) }
          : {}),
        sampleRate,
        codec: format,
        providerRequestId: response.headers.get("x-tt-logid") ?? requestId,
      },
    };
  }
}

function validateRequest(
  input: SoundEffectAudioRequest | MusicAudioRequest,
): void {
  if (!input.prompt?.trim())
    throw new AudioGenerationError("Audio prompt must not be empty", 400);
  if (
    input.durationSeconds !== undefined &&
    (!Number.isFinite(input.durationSeconds) ||
      input.durationSeconds < 1 ||
      input.durationSeconds > 120)
  )
    throw new AudioGenerationError(
      "Seed Audio duration must be between 1 and 120 seconds",
      400,
    );
  if (input.loop)
    throw new AudioGenerationError(
      "Seed Audio does not create guaranteed seamless loops",
      400,
    );
  if (
    input.output?.format !== undefined &&
    input.output.format !== "mp3" &&
    input.output.format !== "wav"
  )
    throw new AudioGenerationError("Seed Audio output must be MP3 or WAV", 400);
  if (
    input.output?.sampleRate !== undefined &&
    !(SAMPLE_RATES as readonly number[]).includes(input.output.sampleRate)
  )
    throw new AudioGenerationError(
      `Unsupported ${DOUBAO_SEED_AUDIO_PROVIDER_NAME} sample rate`,
      400,
    );
  if (input.output?.channels !== undefined)
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} does not expose channel selection`,
      400,
    );
  if (input.operation === "sound-effect" && input.negativePrompt?.trim())
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} does not support negative prompts`,
      400,
    );
  if (input.operation === "music") {
    if (!input.instrumental)
      throw new AudioGenerationError(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} music generation is instrumental only`,
        400,
      );
    if (input.lyrics?.trim())
      throw new AudioGenerationError(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} does not support lyrics in the music tool`,
        400,
      );
    if (input.referenceAssetId)
      throw new AudioGenerationError(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} reference audio is not enabled yet`,
        400,
      );
  }
}

function providerPrompt(
  input: SoundEffectAudioRequest | MusicAudioRequest,
): string {
  const duration =
    input.durationSeconds !== undefined
      ? ` approximately ${input.durationSeconds} seconds long`
      : "";
  if (input.operation === "sound-effect")
    return `Create a standalone game sound effect${duration}. Do not include speech, narration, singing, or background music. Description: ${input.prompt.trim()}`;
  return `Create instrumental game background music${duration}. Do not include vocals, speech, narration, or lyrics. Description: ${input.prompt.trim()}`;
}

interface SeedAudioResponse {
  code?: unknown;
  message?: unknown;
  audio?: unknown;
  duration?: unknown;
}

async function parseResponse(
  response: Response,
): Promise<{ audio: string; duration?: number }> {
  let value: SeedAudioResponse;
  try {
    value = (await response.json()) as SeedAudioResponse;
  } catch {
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} returned invalid JSON`,
      502,
    );
  }
  const code = Number(value.code ?? 0);
  if (code !== 0 && code !== 20_000_000)
    throw new AudioGenerationError(
      typeof value.message === "string" && value.message
        ? value.message
        : `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} failed with code ${code}`,
      providerStatus(code),
    );
  if (typeof value.audio !== "string" || !value.audio.trim())
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} returned no audio`,
      502,
    );
  const duration = finiteDuration(value.duration);
  return {
    audio: value.audio.trim(),
    ...(duration !== undefined ? { duration } : {}),
  };
}

function finiteDuration(value: unknown): number | undefined {
  const duration =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function decodeAudio(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  if (
    !normalized ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  )
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} returned invalid audio data`,
      502,
    );
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES)
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} returned an invalid audio size`,
      502,
    );
  return bytes;
}

function validateAudio(bytes: Uint8Array, format: "mp3" | "wav"): void {
  const valid =
    format === "wav"
      ? bytes.length >= 12 &&
        Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
        Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WAVE"
      : bytes.length >= 3 &&
        (Buffer.from(bytes.subarray(0, 3)).toString("ascii") === "ID3" ||
          (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0));
  if (!valid)
    throw new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} returned data that is not valid ${format.toUpperCase()} audio`,
      502,
    );
}

async function responseError(
  response: Response,
): Promise<AudioGenerationError> {
  const raw = (await response.text().catch(() => "")).slice(0, 500).trim();
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim())
      detail = parsed.message.trim();
  } catch {
    /* Keep the provider's plain-text response. */
  }
  if (response.status === 401 || response.status === 403)
    return new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} credentials were rejected or the service is not enabled`,
      503,
    );
  if (response.status === 429)
    return new AudioGenerationError(
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} rate limit was reached`,
      429,
    );
  return new AudioGenerationError(
    detail ||
      `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} request failed (${response.status})`,
    response.status >= 500 ? 502 : 400,
  );
}

function providerStatus(code: number): number {
  if (code >= 40_000_000 && code < 50_000_000) return 400;
  return 502;
}
