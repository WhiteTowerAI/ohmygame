import {
  AUDIO_VOICE_ID_MAX_LENGTH,
  type AudioGenerationRequest,
  type AudioModel,
  type AudioTranscription,
  type AudioTranscriptionRequest,
  type AudioVoicePage,
  type GeneratedAudio,
} from "../shared/audio.js";
import { AudioGenerationError, type AudioProviderAdapter } from "./audio-generation.js";
import { audioRequestSignal, inspectAudio, MAX_AUDIO_BYTES } from "./audio-media.js";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";
export const ELEVENLABS_PROVIDER_NAME = "ElevenLabs";
const API = "https://api.elevenlabs.io";
/** The default format, available on every plan; 192 kbps and 44.1 kHz PCM need a paid tier. */
const OUTPUT_FORMAT = "mp3_44100_128";
/** ElevenLabs takes 0.7…1.2; the shared scale maps 1 + speed / 100 onto it. */
const SPEED_RANGE = [-30, 20] as const;
/** Speech-to-text accepts files up to 5 GB; the daemon keeps to its own audio limit. */
const MAX_TRANSCRIPTION_BYTES = MAX_AUDIO_BYTES;

type Endpoint = "speech" | "sound" | "music" | "transcription";
const ENDPOINTS = new Map<string, Endpoint>();
const model = (id: string, name: string, endpoint: Endpoint, capabilities: Omit<AudioModel["capabilities"], "formats" | "sampleRatesByFormat">): AudioModel => (ENDPOINTS.set(id, endpoint), {
  provider: ELEVENLABS_PROVIDER_ID,
  providerName: ELEVENLABS_PROVIDER_NAME,
  id,
  name,
  protocol: "elevenlabs-v1",
  capabilities: { formats: ["mp3"], sampleRatesByFormat: { mp3: [44_100] }, ...capabilities },
});

/** Model ids and limits from https://elevenlabs.io/docs/models. */
export const ELEVENLABS_MODELS: readonly AudioModel[] = [
  model("eleven_v4", "Eleven v4", "speech", { produces: ["speech"], readsText: true, maxTextCharacters: 10_000, supportsSpeaker: true, requiresVoice: true, speedRange: SPEED_RANGE }),
  model("eleven_flash_v2_5", "Eleven Flash v2.5", "speech", { produces: ["speech"], readsText: true, maxTextCharacters: 40_000, supportsSpeaker: true, requiresVoice: true, speedRange: SPEED_RANGE }),
  model("eleven_text_to_sound_v3", "Eleven Sound Effects v3", "sound", { produces: ["sound-effect"], minDurationSeconds: 0.5, maxDurationSeconds: 30, supportsLoop: true }),
  model("eleven_text_to_sound_v2", "Eleven Sound Effects v2", "sound", { produces: ["sound-effect"], minDurationSeconds: 0.5, maxDurationSeconds: 30, supportsLoop: true }),
  model("music_v2_5", "Eleven Music v2.5", "music", { produces: ["music"], minDurationSeconds: 3, maxDurationSeconds: 600, supportsInstrumental: true }),
  model("music_v1", "Eleven Music v1", "music", { produces: ["music"], minDurationSeconds: 3, maxDurationSeconds: 600, supportsInstrumental: true }),
  model("scribe_v2", "Scribe v2", "transcription", { produces: [], transcribes: true }),
];

export class ElevenLabsAudioProvider implements AudioProviderAdapter {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly name = ELEVENLABS_PROVIDER_NAME;
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly enabledState: () => boolean = () => true,
  ) {}

  configured(): boolean { return Boolean(this.apiKey()); }
  enabled(): boolean { return this.enabledState(); }
  models(): AudioModel[] { return ELEVENLABS_MODELS.map((candidate) => structuredClone(candidate)); }

  async generate(input: AudioGenerationRequest, signal?: AbortSignal): Promise<GeneratedAudio> {
    const selected = ELEVENLABS_MODELS.find((candidate) => candidate.id === input.model?.id);
    const endpoint = selected && ENDPOINTS.get(selected.id);
    if (!selected || !endpoint || endpoint === "transcription" || input.model?.provider !== this.id) throw new AudioGenerationError(`The selected ${this.name} model can't generate audio`, 400);
    if (endpoint === "speech") {
      const text = input.prompt.trim();
      const voiceId = input.voiceId?.trim();
      if (!text || text.length > (selected.capabilities.maxTextCharacters ?? 10_000)) throw new AudioGenerationError("Speech text is empty or too long", 400);
      if (!voiceId || voiceId.length > AUDIO_VOICE_ID_MAX_LENGTH) throw new AudioGenerationError(`Choose an ${this.name} voice`, 400);
      const language = languageCode(input.language);
      return this.#audio(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, selected, {
        text,
        model_id: selected.id,
        ...(language ? { language_code: language } : {}),
        ...(input.speed !== undefined ? { voice_settings: { speed: speechSpeed(input.speed) } } : {}),
      }, signal);
    }
    if (endpoint === "sound") {
      return this.#audio("/v1/sound-generation", selected, {
        text: requiredPrompt(input.prompt),
        model_id: selected.id,
        ...(input.durationSeconds !== undefined ? { duration_seconds: within(input.durationSeconds, selected) } : {}),
        ...(input.loop ? { loop: true } : {}),
      }, signal);
    }
    return this.#audio("/v1/music", selected, {
      prompt: requiredPrompt(input.prompt),
      model_id: selected.id,
      ...(input.instrumental !== undefined ? { force_instrumental: input.instrumental } : {}),
      ...(input.durationSeconds !== undefined ? { music_length_ms: Math.round(within(input.durationSeconds, selected) * 1000) } : {}),
    }, signal);
  }

  async voices(query: { search?: string; pageToken?: string }, signal?: AbortSignal): Promise<AudioVoicePage> {
    const params = new URLSearchParams({ page_size: "100", include_total_count: "false" });
    if (query.search?.trim()) params.set("search", query.search.trim());
    if (query.pageToken) params.set("next_page_token", query.pageToken);
    const response = await this.#fetch(`/v2/voices?${params}`, { method: "GET" }, signal);
    const body = await response.json() as { voices?: Array<{ voice_id?: unknown; name?: unknown; preview_url?: unknown; labels?: unknown }>; has_more?: unknown; next_page_token?: unknown };
    return {
      voices: (body.voices ?? []).flatMap((voice) => typeof voice.voice_id === "string" && typeof voice.name === "string" ? [{
        id: voice.voice_id,
        name: voice.name,
        ...(typeof voice.preview_url === "string" && voice.preview_url.startsWith("https://") ? { previewUrl: voice.preview_url } : {}),
        ...(voice.labels && typeof voice.labels === "object" ? { labels: Object.fromEntries(Object.entries(voice.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
      }] : []),
      ...(body.has_more === true && typeof body.next_page_token === "string" ? { nextPageToken: body.next_page_token } : {}),
    };
  }

  async transcribe(input: AudioTranscriptionRequest, signal?: AbortSignal): Promise<AudioTranscription> {
    const selected = ELEVENLABS_MODELS.find((candidate) => candidate.id === input.model?.id && candidate.capabilities.transcribes);
    if (!selected) throw new AudioGenerationError(`The selected ${this.name} model can't transcribe`, 400);
    if (!input.bytes.length || input.bytes.length > MAX_TRANSCRIPTION_BYTES) throw new AudioGenerationError("The audio is empty or too large to transcribe", 413);
    const form = new FormData();
    form.set("model_id", selected.id);
    form.set("file", new Blob([new Uint8Array(input.bytes)], { type: input.mediaType }), input.name);
    const language = languageCode(input.language);
    if (language) form.set("language_code", language);
    const response = await this.#fetch("/v1/speech-to-text", { method: "POST", body: form }, signal);
    const body = await response.json() as { text?: unknown; language_code?: unknown };
    if (typeof body.text !== "string") throw new AudioGenerationError(`${this.name} returned no transcript`, 502);
    return { text: body.text.trim(), ...(typeof body.language_code === "string" ? { language: body.language_code } : {}), model: { provider: this.id, id: selected.id } };
  }

  async #audio(path: string, selected: AudioModel, body: Record<string, unknown>, signal?: AbortSignal): Promise<GeneratedAudio> {
    const response = await this.#fetch(`${path}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, signal);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new AudioGenerationError(`${this.name} returned invalid audio`, 502);
    const info = await inspectAudio(bytes, "mp3", 502);
    const requestId = response.headers.get("request-id");
    return {
      bytes,
      mediaType: "audio/mpeg",
      model: { provider: this.id, id: selected.id },
      metadata: { durationMs: info.durationMs, sampleRate: info.sampleRate, channels: info.channels, codec: info.codec, ...(requestId ? { providerRequestId: requestId } : {}) },
    };
  }

  async #fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const key = this.apiKey();
    if (!key) throw new AudioGenerationError(`Connect ${this.name} first`, 503);
    let response: Response;
    try {
      response = await this.request(`${API}${path}`, { ...init, headers: { ...init.headers as Record<string, string>, "xi-api-key": key }, signal: audioRequestSignal(signal) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(`Could not reach ${this.name}: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
    }
    if (!response.ok) throw await elevenLabsError(response);
    return response;
  }
}

/** ElevenLabs takes an ISO 639-1 or 639-3 code; OhMyGame's settings may carry a region, as in `zh-cn`. */
export function languageCode(language: string | undefined): string | undefined {
  const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

/** Maps the shared -50…100 scale onto ElevenLabs' 0.7…1.2. */
export function speechSpeed(speed: number): number {
  return Math.round(Math.max(0.7, Math.min(1.2, 1 + speed / 100)) * 100) / 100;
}

function requiredPrompt(prompt: string): string {
  const text = prompt.trim();
  if (!text) throw new AudioGenerationError("Add a prompt before generating", 400);
  return text;
}

function within(seconds: number, selected: AudioModel): number {
  const { minDurationSeconds = 0, maxDurationSeconds = Infinity } = selected.capabilities;
  if (!Number.isFinite(seconds) || seconds < minDurationSeconds || seconds > maxDurationSeconds) {
    throw new AudioGenerationError(`${selected.name} makes audio from ${minDurationSeconds} to ${maxDurationSeconds} seconds long`, 400);
  }
  return seconds;
}

async function elevenLabsError(response: Response): Promise<AudioGenerationError> {
  let message = `${ELEVENLABS_PROVIDER_NAME} request failed (${response.status})`;
  try {
    const body = await response.json() as { detail?: unknown };
    const detail = body.detail;
    if (typeof detail === "string") message = detail;
    else if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") message = detail.message;
    else if (Array.isArray(detail) && typeof detail[0]?.msg === "string") message = detail[0].msg;
  } catch { /* Not JSON: keep the status. */ }
  const status = response.status === 401 || response.status === 403 ? 503 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
  return new AudioGenerationError(`${ELEVENLABS_PROVIDER_NAME}: ${message.slice(0, 500)}`, status);
}
