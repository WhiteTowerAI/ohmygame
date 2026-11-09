import { AUDIO_VOICE_ID_MAX_LENGTH, type AudioGenerationRequest, type AudioModel, type GeneratedAudio, type SpeechAudioRequest } from "../shared/audio.js";
import { AudioGenerationError, type AudioProviderAdapter } from "./audio-generation.js";
import { audioHttpError, audioRequestSignal, inspectAudio, MAX_AUDIO_BYTES } from "./audio-media.js";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";
export const ELEVENLABS_PROVIDER_NAME = "ElevenLabs";
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
export const ELEVENLABS_TTS_MODELS: readonly AudioModel[] = [
  { provider: ELEVENLABS_PROVIDER_ID, providerName: ELEVENLABS_PROVIDER_NAME, id: "eleven_v4", name: "Eleven v4", protocol: "elevenlabs-tts-v1", capabilities: { operations: ["speech"], executionModes: ["synchronous", "streaming"], formats: ["mp3"], sampleRatesByFormat: { mp3: [44100] }, supportsSpeaker: true, maxTextCharacters: 10000 } },
  { provider: ELEVENLABS_PROVIDER_ID, providerName: ELEVENLABS_PROVIDER_NAME, id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", protocol: "elevenlabs-tts-v1", capabilities: { operations: ["speech"], executionModes: ["synchronous", "streaming"], formats: ["mp3"], sampleRatesByFormat: { mp3: [44100] }, supportsSpeaker: true, maxTextCharacters: 40000 } },
];

export class ElevenLabsTtsProvider implements AudioProviderAdapter {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly name = ELEVENLABS_PROVIDER_NAME;
  constructor(private readonly apiKey: () => string | undefined, private readonly request: typeof fetch = fetch, private readonly enabledState: () => boolean = () => true) {}
  configured(): boolean { return Boolean(this.apiKey()); }
  enabled(): boolean { return this.enabledState(); }
  models(): AudioModel[] { return ELEVENLABS_TTS_MODELS.map((model) => structuredClone(model)); }
  async generate(input: AudioGenerationRequest, signal?: AbortSignal): Promise<GeneratedAudio> {
    if (input.operation !== "speech") throw new AudioGenerationError("ElevenLabs currently supports speech generation only", 400);
    const speech = input as SpeechAudioRequest;
    const model = ELEVENLABS_TTS_MODELS.find((candidate) => candidate.id === input.model?.id);
    const key = this.apiKey();
    const voiceId = speech.voiceId?.trim();
    if (!key) throw new AudioGenerationError("ElevenLabs is not connected", 503);
    if (!model || input.model?.provider !== ELEVENLABS_PROVIDER_ID) throw new AudioGenerationError("The selected ElevenLabs model is unavailable", 400);
    if (!speech.text.trim() || speech.text.length > (model.capabilities.maxTextCharacters ?? 10000)) throw new AudioGenerationError("Speech text is invalid or too long", 400);
    if (!voiceId || voiceId.length > AUDIO_VOICE_ID_MAX_LENGTH) throw new AudioGenerationError("Choose an ElevenLabs voice", 400);
    let response: Response;
    try { response = await this.request(`${ENDPOINT}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, { method: "POST", headers: { "content-type": "application/json", "xi-api-key": key }, body: JSON.stringify({ text: speech.text.trim(), model_id: model.id, ...(speech.language ? { language_code: speech.language } : {}), ...(speech.speed !== undefined ? { voice_settings: { speed: Math.max(0.7, Math.min(1.2, 1 + speech.speed / 100)) } } : {}) }), signal: audioRequestSignal(signal) }); }
    catch (cause) { if (signal?.aborted) throw cause; throw new AudioGenerationError(`Could not reach ElevenLabs: ${cause instanceof Error ? cause.message : String(cause)}`, 502); }
    if (!response.ok) throw await audioHttpError(response, this.name);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new AudioGenerationError("ElevenLabs returned invalid audio", 502);
    const info = await inspectAudio(bytes, "mp3", 502);
    return { bytes, mediaType: "audio/mpeg", model: { provider: this.id, id: model.id }, metadata: { durationMs: info.durationMs, sampleRate: info.sampleRate, channels: info.channels, codec: info.codec, providerRequestId: response.headers.get("request-id") ?? undefined } };
  }
}
