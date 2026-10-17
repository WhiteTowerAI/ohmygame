import { randomUUID } from "node:crypto";
import {
  AUDIO_VOICE_ID_MAX_LENGTH,
  AUDIO_VOICE_ID_PATTERN,
  DOUBAO_SPEECH_PROVIDER_NAME,
  type AudioGenerationRequest,
  type AudioModel,
  type GeneratedAudio,
  type SpeechAudioRequest,
} from "../shared/audio.js";
import {
  AudioGenerationError,
  type AudioProviderAdapter,
} from "./audio-generation.js";

const DEFAULT_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const PROVIDER_ID = "volcengine-tts";
const RESOURCE_ID = "seed-tts-2.0";

export const VOLCENGINE_TTS_MODELS: readonly AudioModel[] = [
  model("seed-tts-2.0", "Doubao Speech Synthesis 2.0"),
];

export class VolcengineTtsProvider implements AudioProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly name = DOUBAO_SPEECH_PROVIDER_NAME;

  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly baseUrl = DEFAULT_ENDPOINT,
    private readonly isEnabled: () => boolean = () => true,
    private readonly configuredVoiceId: () => string | undefined = () =>
      undefined,
  ) {}

  configured(): boolean {
    return Boolean(this.apiKey());
  }
  enabled(): boolean {
    return this.isEnabled();
  }
  models(): AudioModel[] {
    return VOLCENGINE_TTS_MODELS.map((entry) => structuredClone(entry));
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    if (input.operation !== "speech")
      throw new AudioGenerationError(
        `${DOUBAO_SPEECH_PROVIDER_NAME} currently supports speech generation only`,
        400,
      );
    const model = VOLCENGINE_TTS_MODELS.find(
      (entry) => entry.id === input.model?.id,
    );
    if (!model || input.model?.provider !== PROVIDER_ID)
      throw new AudioGenerationError(
        `The selected ${DOUBAO_SPEECH_PROVIDER_NAME} model is unavailable`,
        400,
      );
    const key = this.apiKey();
    if (!key)
      throw new AudioGenerationError(`${DOUBAO_SPEECH_PROVIDER_NAME} is not connected`, 503);
    const voiceId = input.voiceId?.trim() || this.configuredVoiceId()?.trim();
    validateSpeech(input, voiceId);
    const requestId = randomUUID();
    const format = input.output?.format ?? "mp3";
    const sampleRate = input.output?.sampleRate ?? 24_000;
    const additions: Record<string, unknown> = {};
    if (input.language) additions.explicit_language = input.language;
    if (input.style?.trim()) additions.context_texts = [input.style.trim()];
    let response: Response;
    try {
      response = await this.request(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": key,
          "X-Api-Resource-Id": RESOURCE_ID,
          "X-Api-Request-Id": requestId,
          "X-Control-Require-Usage-Tokens-Return": "*",
        },
        body: JSON.stringify({
          req_params: {
            text: input.text.trim(),
            speaker: voiceId,
            audio_params: {
              format,
              sample_rate: sampleRate,
              ...(input.speed !== undefined
                ? { speech_rate: Math.round(input.speed) }
                : {}),
            },
            ...(Object.keys(additions).length
              ? { additions: JSON.stringify(additions) }
              : {}),
          },
        }),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(
        `Could not reach ${DOUBAO_SPEECH_PROVIDER_NAME}: ${cause instanceof Error ? cause.message : String(cause)}`,
        502,
      );
    }
    if (!response.ok) throw await responseError(response);
    const result = await parseChunkedResponse(response);
    if (!result.bytes.length)
      throw new AudioGenerationError(`${DOUBAO_SPEECH_PROVIDER_NAME} returned no audio`, 502);
    return {
      bytes: result.bytes,
      mediaType: format === "wav" ? "audio/wav" : "audio/mpeg",
      model: { provider: PROVIDER_ID, id: model.id },
      metadata: {
        sampleRate,
        channels: 1,
        codec: format,
        providerRequestId: response.headers.get("x-tt-logid") ?? requestId,
        ...(result.usageCharacters !== undefined
          ? { usageCharacters: result.usageCharacters }
          : {}),
      },
    };
  }
}

function model(id: string, name: string): AudioModel {
  return {
    provider: PROVIDER_ID,
    providerName: DOUBAO_SPEECH_PROVIDER_NAME,
    id,
    name,
    protocol: "volcengine-tts-v3",
    capabilities: {
      operations: ["speech"],
      executionModes: ["streaming"],
      languages: [
        "zh-cn",
        "en",
        "ja",
        "es-mx",
        "id",
        "pt-br",
        "pt",
        "ko",
        "it",
        "de",
        "fr",
        "th",
        "vi",
        "ru",
        "fil",
        "ms",
        "ar",
        "pl",
        "tr",
        "sv",
        "nl",
        "no",
        "uk",
        "fi",
        "da",
        "cs",
        "hu",
        "el",
        "ro",
        "hi",
        "es-es",
      ],
      formats: ["mp3"],
      sampleRates: [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000],
      maxTextCharacters: 10_000,
      supportsVoiceClone: false,
      supportsAlignment: true,
    },
  };
}

function validateSpeech(input: SpeechAudioRequest, voiceId?: string): void {
  if (!input.text?.trim())
    throw new AudioGenerationError("Speech text must not be empty", 400);
  if (input.text.length > 10_000)
    throw new AudioGenerationError(
      "Speech text must be 10,000 characters or fewer",
      400,
    );
  if (!voiceId || voiceId.length > AUDIO_VOICE_ID_MAX_LENGTH || !new RegExp(AUDIO_VOICE_ID_PATTERN).test(voiceId))
    throw new AudioGenerationError(
      "Choose a Volcengine Speaker ID or configure a default voice",
      400,
    );
  if (
    input.speed !== undefined &&
    (!Number.isFinite(input.speed) || input.speed < -50 || input.speed > 100)
  )
    throw new AudioGenerationError(
      "Speech rate must be between -50 and 100",
      400,
    );
  if (input.output?.format !== undefined && input.output.format !== "mp3")
    throw new AudioGenerationError(
      "Volcengine streaming TTS currently uses MP3 output",
      400,
    );
  if (
    input.output?.sampleRate !== undefined &&
    ![8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].includes(
      input.output.sampleRate,
    )
  )
    throw new AudioGenerationError(
      `Unsupported ${DOUBAO_SPEECH_PROVIDER_NAME} sample rate`,
      400,
    );
  if (input.output?.channels !== undefined && input.output.channels !== 1)
    throw new AudioGenerationError(
      `${DOUBAO_SPEECH_PROVIDER_NAME} currently returns mono audio`,
      400,
    );
}

async function parseChunkedResponse(
  response: Response,
): Promise<{ bytes: Uint8Array; usageCharacters?: number }> {
  const chunks: Buffer[] = [];
  let usageCharacters: number | undefined;
  const parseLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    let value: {
      code?: unknown;
      message?: unknown;
      data?: unknown;
      usage?: { text_words?: unknown };
    };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      throw new AudioGenerationError(
        `${DOUBAO_SPEECH_PROVIDER_NAME} returned an invalid streaming response`,
        502,
      );
    }
    const code = Number(value.code ?? 0);
    // Volcengine streams data chunks with code 0 and finishes with a final
    // event carrying code 20000000 ("OK") plus usage stats; both are success.
    if (code !== 0 && code !== 20_000_000)
      throw new AudioGenerationError(
        typeof value.message === "string" && value.message
          ? value.message
          : `${DOUBAO_SPEECH_PROVIDER_NAME} failed with code ${code}`,
        providerStatus(code),
      );
    if (typeof value.data === "string" && value.data) {
      try {
        chunks.push(Buffer.from(value.data, "base64"));
      } catch {
        throw new AudioGenerationError(
          `${DOUBAO_SPEECH_PROVIDER_NAME} returned invalid audio data`,
          502,
        );
      }
    }
    if (typeof value.usage?.text_words === "number")
      usageCharacters = value.usage.text_words;
  };
  if (!response.body)
    throw new AudioGenerationError(
      `${DOUBAO_SPEECH_PROVIDER_NAME} returned an empty streaming response`,
      502,
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
    if (done) break;
  }
  if (pending.trim()) parseLine(pending);
  return {
    bytes: Buffer.concat(chunks),
    ...(usageCharacters !== undefined ? { usageCharacters } : {}),
  };
}

async function responseError(
  response: Response,
): Promise<AudioGenerationError> {
  const detail = (await response.text().catch(() => "")).slice(0, 500).trim();
  if (response.status === 401 || response.status === 403)
    return new AudioGenerationError(
      `${DOUBAO_SPEECH_PROVIDER_NAME} credentials were rejected`,
      503,
    );
  if (response.status === 429)
    return new AudioGenerationError(
      `${DOUBAO_SPEECH_PROVIDER_NAME} rate limit was reached`,
      429,
    );
  return new AudioGenerationError(
    detail || `${DOUBAO_SPEECH_PROVIDER_NAME} request failed (${response.status})`,
    response.status >= 500 ? 502 : 400,
  );
}

function providerStatus(code: number): number {
  return code === 45_000_010 || code === 45_000_011 ? 429 : 502;
}
