import { randomUUID } from "node:crypto";
import {
  AUDIO_VOICE_ID_MAX_LENGTH,
  AUDIO_VOICE_ID_PATTERN,
  DOUBAO_SPEECH_PROVIDER_NAME,
  DOUBAO_TTS_DIALECTS,
  findVolcengineTtsVoice,
  type AudioGenerationRequest,
  type AudioModel,
  type GeneratedAudio,
  type SpeechAudioRequest,
  type AudioSentence,
  type AudioReferenceData,
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
  MAX_AUDIO_BYTES,
  subtitleWord,
  audioHttpError,
  validateControl,
} from "./audio-media.js";

const DEFAULT_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const PROVIDER_ID = "volcengine-tts";
const BIT_RATES = [16000, 32000, 64000, 160000];

export const VOLCENGINE_TTS_MODELS: readonly AudioModel[] = [
  {
    provider: PROVIDER_ID,
    providerName: DOUBAO_SPEECH_PROVIDER_NAME,
    id: "seed-tts-2.0",
    name: "Doubao Speech Synthesis 2.0",
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
      formats: ["mp3", "ogg_opus"],
      sampleRatesByFormat: {
        mp3: [8000, 16000, 22050, 24000, 32000, 44100, 48000],
        ogg_opus: [48000],
      },
      supportsSpeaker: true,
      supportsPitch: true,
      supportsVolume: true,
      supportsStyle: true,
      supportsSSML: true,
      supportsSpeechOptions: true,
      subtitleLanguages: ["zh-cn", "en"],
      maxTextCharacters: 10_000,
      supportsVoiceClone: false,
      supportsAlignment: true,
    },
  },
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

  defaultVoiceId(): string | undefined {
    return this.configuredVoiceId();
  }
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
    references: readonly AudioReferenceData[] = [],
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
      throw new AudioGenerationError(
        `${DOUBAO_SPEECH_PROVIDER_NAME} is not connected`,
        503,
      );
    const voiceId = input.voiceId?.trim() || this.configuredVoiceId()?.trim();
    validateSpeech(input, model, voiceId);
    if (references.length || input.references?.length)
      throw new AudioGenerationError(
        "Choose Seed Audio to use image or audio references",
        400,
      );
    const requestId = randomUUID();
    const format = input.output?.format ?? "mp3";
    const sampleRate =
      input.output?.sampleRate ?? (format === "ogg_opus" ? 48000 : 24000);
    const additions: Record<string, unknown> = {};
    if (input.language) additions.explicit_language = input.language;
    if (input.style?.trim()) additions.context_texts = [input.style.trim()];
    if (input.autoLanguage) additions.enable_auto_language_recognition = true;
    if (input.dialect) additions.explicit_dialect = input.dialect;
    if (input.pitch !== undefined)
      additions.post_process = { pitch: input.pitch };
    if (input.silenceMs !== undefined)
      additions.silence_duration = input.silenceMs;
    if (input.sectionId) additions.section_id = input.sectionId;
    // SSML is only parsed while the Markdown filter is off.
    if (input.ssml) additions.disable_markdown_filter = false;
    if (input.pronunciation?.length)
      additions.pronunciation_dict = {
        tone: input.pronunciation.map(
          (entry) => `${entry.word}/${entry.replacement}`,
        ),
      };
    if (input.output?.bitRate !== undefined && input.output.bitRate < 64000)
      additions.disable_default_bit_rate = true;
    const requestSignal = audioRequestSignal(signal);
    let response: Response;
    try {
      response = await this.request(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": key,
          "X-Api-Resource-Id":
            input.voiceKind === "cloned" ? "seed-icl-2.0" : "seed-tts-2.0",
          "X-Api-Request-Id": requestId,
          "X-Control-Require-Usage-Tokens-Return": "*",
        },
        body: JSON.stringify({
          req_params: {
            text: input.text.trim(),
            speaker: voiceId,
            ...(input.voiceKind === "cloned"
              ? { model: `seed-tts-2.0-${input.voiceModel ?? "standard"}` }
              : {}),
            ...(input.ssml ? { ssml: input.ssml } : {}),
            audio_params: {
              format,
              sample_rate: sampleRate,
              ...(input.volume !== undefined
                ? { loudness_rate: input.volume }
                : {}),
              ...(input.subtitles !== undefined
                ? { enable_subtitle: input.subtitles }
                : {}),
              ...(input.output?.bitRate !== undefined
                ? { bit_rate: input.output.bitRate }
                : {}),
              ...(input.speed !== undefined
                ? { speech_rate: Math.round(input.speed) }
                : {}),
            },
            ...(Object.keys(additions).length
              ? { additions: JSON.stringify(additions) }
              : {}),
          },
        }),
        signal: requestSignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(
        `Could not reach ${DOUBAO_SPEECH_PROVIDER_NAME}: ${cause instanceof Error ? cause.message : String(cause)}`,
        502,
      );
    }
    if (!response.ok) throw await audioHttpError(response, this.name);
    const result = await parseChunkedResponse(response);
    if (!result.bytes.length)
      throw new AudioGenerationError(
        `${DOUBAO_SPEECH_PROVIDER_NAME} returned no audio`,
        502,
      );
    const info = await inspectAudio(result.bytes, format, 502);
    return {
      ...(input.subtitles && result.sentences.length
        ? {
            subtitles: {
              text: result.sentences.map((sentence) => sentence.text).join(""),
              sentences: result.sentences,
            },
          }
        : {}),
      bytes: result.bytes,
      mediaType: format === "ogg_opus" ? "audio/ogg" : "audio/mpeg",
      model: { provider: PROVIDER_ID, id: model.id },
      metadata: {
        sampleRate: info.sampleRate,
        durationMs: info.durationMs,
        channels: info.channels,
        codec: format,
        providerRequestId: response.headers.get("x-tt-logid") ?? requestId,
        ...(result.usageCharacters !== undefined
          ? { usageCharacters: result.usageCharacters }
          : {}),
      },
    };
  }
}

function validateSpeech(
  input: SpeechAudioRequest,
  model: AudioModel,
  voiceId?: string,
): void {
  const caps = model.capabilities;
  if (!input.text?.trim())
    throw new AudioGenerationError("Speech text must not be empty", 400);
  if (input.text.length > caps.maxTextCharacters!)
    throw new AudioGenerationError(
      `Speech text must be ${caps.maxTextCharacters!.toLocaleString("en")} characters or fewer`,
      400,
    );
  if (
    !voiceId ||
    voiceId.length > AUDIO_VOICE_ID_MAX_LENGTH ||
    !new RegExp(AUDIO_VOICE_ID_PATTERN).test(voiceId)
  )
    throw new AudioGenerationError(
      "Choose a Volcengine Speaker ID or configure a default voice",
      400,
    );
  validateControl(input.speed, -50, 100, "Speech rate");
  validateControl(input.pitch, -12, 12, "Pitch");
  validateControl(input.volume, -50, 100, "Volume");
  validateControl(input.silenceMs, 0, 30000, "Trailing silence");
  const format = input.output?.format ?? "mp3";
  if (!caps.formats.includes(format))
    throw new AudioGenerationError(
      `${DOUBAO_SPEECH_PROVIDER_NAME} supports MP3 or Ogg Opus output`,
      400,
    );
  if (
    input.output?.sampleRate !== undefined &&
    !caps.sampleRatesByFormat?.[format]?.includes(input.output.sampleRate)
  )
    throw new AudioGenerationError(
      `Unsupported ${DOUBAO_SPEECH_PROVIDER_NAME} format or sample rate`,
      400,
    );
  if (input.output?.channels !== undefined && input.output.channels !== 1)
    throw new AudioGenerationError(
      `${DOUBAO_SPEECH_PROVIDER_NAME} currently returns mono audio`,
      400,
    );
  if (
    input.output?.bitRate !== undefined &&
    !BIT_RATES.includes(input.output.bitRate)
  )
    throw new AudioGenerationError("Unsupported audio bit rate", 400);
  if (input.language && !caps.languages!.includes(input.language))
    throw new AudioGenerationError("Unsupported speech language", 400);
  if (
    input.subtitles &&
    input.language &&
    !caps.subtitleLanguages!.includes(input.language)
  )
    throw new AudioGenerationError(
      "TTS subtitles support Chinese and English only",
      400,
    );
  // Custom and cloned Speaker IDs are not in the catalog, so only known presets are checked.
  const preset =
    input.voiceKind === "cloned" ? undefined : findVolcengineTtsVoice(voiceId);
  if (input.voiceKind === "cloned" && input.style)
    throw new AudioGenerationError(
      "Voice instructions are unavailable for cloned voices",
      400,
    );
  if (preset?.noInstructions && input.style)
    throw new AudioGenerationError(
      `${preset.name} does not follow voice instructions`,
      400,
    );
  if (input.voiceModel && input.voiceKind !== "cloned")
    throw new AudioGenerationError(
      "A voice model can only be selected for cloned voices",
      400,
    );
  if (
    input.dialect &&
    !(DOUBAO_TTS_DIALECTS as readonly string[]).includes(input.dialect)
  )
    throw new AudioGenerationError("Unsupported dialect", 400);
  if (input.dialect && preset && !preset.dialects)
    throw new AudioGenerationError(
      `${preset.name} does not support dialects`,
      400,
    );
  if (input.ssml && input.pronunciation?.length)
    throw new AudioGenerationError(
      "Use SSML or a pronunciation dictionary separately",
      400,
    );
  if (input.ssml && preset && !["zh-cn", "en"].includes(preset.language))
    throw new AudioGenerationError(
      "SSML is available for Chinese and English voices only",
      400,
    );
  if (input.pronunciation?.length) {
    const words = new Set<string>();
    if (input.pronunciation.length > 5000)
      throw new AudioGenerationError(
        "Pronunciation dictionary is too large",
        400,
      );
    for (const entry of input.pronunciation) {
      if (
        !entry.word ||
        entry.word.length > 9 ||
        /[\s/]/.test(entry.word) ||
        !entry.replacement ||
        words.has(entry.word)
      )
        throw new AudioGenerationError(
          "Invalid or duplicate pronunciation entry",
          400,
        );
      words.add(entry.word);
    }
  }
}

async function parseChunkedResponse(response: Response): Promise<{
  bytes: Uint8Array;
  usageCharacters?: number;
  sentences: AudioSentence[];
}> {
  const chunks: Uint8Array[] = [];
  const sentences: AudioSentence[] = [];
  const seenSentences = new Set<string>();
  let totalBytes = 0;
  let usageCharacters: number | undefined;
  const parseLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    let value: {
      code?: unknown;
      message?: unknown;
      data?: unknown;
      usage?: { text_words?: unknown };
      sentence?: { text?: string; words?: unknown[] };
    };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      throw new AudioGenerationError(
        `${DOUBAO_SPEECH_PROVIDER_NAME} returned an invalid streaming response`,
        502,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new AudioGenerationError("Invalid speech stream event", 502);
    const code = Number(value.code ?? 0);
    // Volcengine streams data chunks with code 0 and finishes with a final
    // event carrying code 20000000 ("OK") plus usage stats; both are success.
    if (code !== 0 && code !== 20_000_000) {
      const message =
        typeof value.message === "string" && value.message
          ? value.message
          : `${DOUBAO_SPEECH_PROVIDER_NAME} failed with code ${code}`;
      throw new AudioGenerationError(message, doubaoErrorStatus(code, message));
    }
    if (typeof value.data === "string" && value.data) {
      const bytes = decodeAudioBase64(value.data);
      totalBytes += bytes.length;
      if (totalBytes > MAX_AUDIO_BYTES)
        throw new AudioGenerationError("Speech audio is too large", 502);
      chunks.push(bytes);
    }
    if (value.sentence?.words?.length) {
      const words = value.sentence.words.map((word) =>
        subtitleWord(word, false),
      );
      const sentence = {
        text: value.sentence.text ?? words.map((word) => word.text).join(""),
        startMs: words[0]!.startMs,
        endMs: words.at(-1)!.endMs,
        words,
      };
      const key = JSON.stringify(sentence);
      if (!seenSentences.has(key)) {
        sentences.push(sentence);
        seenSentences.add(key);
      }
    }
    if (
      typeof value.usage?.text_words === "number" &&
      Number.isFinite(value.usage.text_words)
    )
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
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > MAX_AUDIO_BYTES * 2)
        throw new AudioGenerationError(
          "Speech response line is too large",
          502,
        );
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
      if (done) break;
    }
    if (pending.trim()) parseLine(pending);
  } catch (cause) {
    await reader.cancel().catch(() => {});
    if (cause instanceof AudioGenerationError) throw cause;
    throw new AudioGenerationError("Could not read the speech stream", 502);
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: Buffer.concat(chunks),
    sentences,
    ...(usageCharacters !== undefined ? { usageCharacters } : {}),
  };
}
