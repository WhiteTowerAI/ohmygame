import { createHash } from "node:crypto";
import {
  GPT_SOVITS_PROVIDER_NAME,
  type AudioGenerationRequest,
  type AudioModel,
  type GeneratedAudio,
} from "../shared/audio.js";
import { AudioGenerationError, type AudioProviderAdapter } from "./audio-generation.js";
import { inspectAudio } from "./audio-media.js";

const PROVIDER_ID = "gpt-sovits";
const MODEL_ID = "gpt-sovits";
const MAX_TEXT_CHARACTERS = 500;
const POLL_INTERVAL_MS = 4_000;
/** Queued tasks only count against this cap; the synthesis budget starts once the task runs. */
const ABSOLUTE_TIMEOUT_MS = 60 * 60_000;
const SYNTHESIS_TIMEOUT_CAP_MS = 30 * 60_000;
/** RTF≈60 on a memory-constrained gateway host; ~4.5 characters per second of speech. */
const SYNTHESIS_MS_PER_CHARACTER = (60 / 4.5) * 1_000;
const SYNTHESIS_BASE_MS = 120_000;

export const GPT_SOVITS_MODELS: readonly AudioModel[] = [
  {
    provider: PROVIDER_ID,
    providerName: GPT_SOVITS_PROVIDER_NAME,
    id: MODEL_ID,
    name: "GPT-SoVITS (self-hosted)",
    protocol: "gpt-sovits-api-v2",
    capabilities: {
      operations: ["speech"],
      executionModes: ["async-task"],
      languages: ["zh-cn", "en", "ja", "ko", "yue"],
      formats: ["wav"],
      maxTextCharacters: MAX_TEXT_CHARACTERS,
      supportsVoiceClone: true,
    },
  },
];

export interface GsvVoiceEntry {
  /** Stable ASCII id (`gsv-<hash>`); empty for voices without reference audio. */
  id: string;
  label: string;
  voice: string;
  emotion: string;
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
  available: boolean;
}

/** Stable voice id derived from the voice name and reference audio path inside the gateway voice packs. */
export function gsvVoiceId(voice: string, refFile: string): string {
  return `gsv-${createHash("sha1").update(`${voice}@${refFile}`).digest("hex").slice(0, 10)}`;
}

function promptLanguage(refFile: string): string {
  if (refFile.includes("/English/") || refFile.includes("/en/")) return "en";
  if (refFile.includes("/日文/") || refFile.includes("/日语/") || refFile.includes("/ja/")) return "ja";
  if (refFile.includes("/韩语/") || refFile.includes("/ko/")) return "ko";
  if (refFile.includes("/粤语/") || refFile.includes("/yue/")) return "yue";
  return "zh";
}

function textLanguage(language: string | undefined, fallback: string): string {
  if (language === "zh-cn" || language === "zh-CN") return "zh";
  // Gateway text_lang values (auto, zh, ja, yue, ko, all_*, en) pass through unchanged.
  return language ?? fallback;
}

interface GatewayVoiceRef {
  file?: unknown;
  emotion?: unknown;
  prompt_text?: unknown;
}

interface GatewayVoice {
  voice?: unknown;
  refs?: unknown;
  tags?: unknown;
}

/** Self-hosted GPT-SoVITS speech provider driven by a gsv-gateway async task queue. */
export class GptSovitsProvider implements AudioProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly name = GPT_SOVITS_PROVIDER_NAME;

  constructor(
    private readonly baseUrl: () => string | undefined,
    private readonly token: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly isEnabled: () => boolean = () => true,
    private readonly configuredVoiceId: () => string | undefined = () => undefined,
  ) {}

  defaultVoiceId(): string | undefined {
    return this.configuredVoiceId();
  }

  configured(): boolean {
    return Boolean(this.baseUrl());
  }

  enabled(): boolean {
    return this.isEnabled();
  }

  models(): AudioModel[] {
    return GPT_SOVITS_MODELS.map((entry) => structuredClone(entry));
  }

  /** Voice catalog from the gateway; entries with reference audio carry a stable selection id. */
  async voices(signal?: AbortSignal): Promise<GsvVoiceEntry[]> {
    const entries = await this.#fetchVoices(signal);
    return entries.map((entry) => ({ ...entry }));
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    if (input.operation !== "speech") {
      throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} currently supports speech generation only`, 400);
    }
    if (input.model?.provider !== PROVIDER_ID || (input.model && input.model.id !== MODEL_ID)) {
      throw new AudioGenerationError(`The selected ${GPT_SOVITS_PROVIDER_NAME} model is unavailable`, 400);
    }
    const baseUrl = this.baseUrl();
    if (!baseUrl) throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} is not connected`, 503);
    const text = input.text.trim();
    if (!text) throw new AudioGenerationError("Speech text must not be empty", 400);
    if (text.length > MAX_TEXT_CHARACTERS) {
      throw new AudioGenerationError(`Speech text exceeds the ${MAX_TEXT_CHARACTERS} character limit`, 400);
    }

    const voice = await this.#resolveVoice(input.voiceId, signal);
    const promptLang = voice.promptLang ?? "zh";
    const taskId = await this.#submit(baseUrl, {
      text,
      text_lang: textLanguage(input.language, promptLang),
      ref_audio_path: voice.refAudioPath ?? "",
      prompt_text: voice.promptText ?? "",
      prompt_lang: promptLang,
      ...(input.speed !== undefined
        ? { speed_factor: String(Math.min(2, Math.max(0.5, 1 + input.speed / 100))) }
        : {}),
      media_type: "wav",
    }, signal);
    const audioBytes = await this.#collect(baseUrl, taskId, text.length, signal);
    const info = await inspectAudio(audioBytes, "wav", 502);
    return {
      bytes: audioBytes,
      mediaType: "audio/wav",
      model: { provider: PROVIDER_ID, id: MODEL_ID },
      metadata: {
        sampleRate: info.sampleRate,
        durationMs: info.durationMs,
        channels: info.channels,
        codec: "wav",
      },
    };
  }

  #authHeaders(): Record<string, string> {
    const token = this.token();
    return token ? { "X-GSV-Token": token } : {};
  }

  async #fetchVoices(signal?: AbortSignal): Promise<GsvVoiceEntry[]> {
    const baseUrl = this.baseUrl();
    if (!baseUrl) throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} is not connected`, 503);
    let response: Response;
    try {
      response = await this.request(`${baseUrl}/voices`, {
        headers: this.#authHeaders(),
        signal: signal ?? undefined,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(`Could not reach ${GPT_SOVITS_PROVIDER_NAME}: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} rejected the request — check the gateway token setting`, 502);
    }
    if (!response.ok) throw new AudioGenerationError(`Could not list ${GPT_SOVITS_PROVIDER_NAME} voices`, 502);
    const payload = await response.json().catch(() => null) as { voices?: unknown } | null;
    const voices = Array.isArray(payload?.voices) ? (payload.voices as GatewayVoice[]) : [];
    const entries: GsvVoiceEntry[] = [];
    for (const voice of voices) {
      const name = typeof voice.voice === "string" ? voice.voice : "";
      const refs = Array.isArray(voice.refs) ? (voice.refs as GatewayVoiceRef[]) : [];
      const usable = refs.filter((ref) => typeof ref.file === "string" && ref.file);
      if (!usable.length) {
        entries.push({ id: "", label: name, voice: name, emotion: "", available: false });
        continue;
      }
      for (const ref of usable) {
        const file = ref.file as string;
        const emotion = typeof ref.emotion === "string" ? ref.emotion : "";
        entries.push({
          id: gsvVoiceId(name, file),
          label: emotion ? `${name} · ${emotion}` : name,
          voice: name,
          emotion,
          refAudioPath: file,
          promptText: typeof ref.prompt_text === "string" ? ref.prompt_text : undefined,
          promptLang: promptLanguage(file),
          available: true,
        });
      }
    }
    return entries;
  }

  async #resolveVoice(voiceId: string | undefined, signal?: AbortSignal): Promise<GsvVoiceEntry> {
    const entries = await this.#fetchVoices(signal);
    const available = entries.filter((entry) => entry.available);
    const wanted = voiceId?.trim() || this.configuredVoiceId()?.trim();
    const match = wanted ? available.find((entry) => entry.id === wanted) : undefined;
    const chosen = match ?? available[0];
    if (!chosen) {
      throw new AudioGenerationError(
        `${GPT_SOVITS_PROVIDER_NAME} has no voice packs with reference audio; add one under the gateway voice-packs directory`,
        502,
      );
    }
    return chosen;
  }

  /** The gateway takes /tts/async parameters in the query string, not the request body. */
  async #submit(baseUrl: string, params: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await this.request(`${baseUrl}/tts/async?${query}`, {
        method: "POST",
        headers: this.#authHeaders(),
        signal: signal ?? undefined,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(`Could not reach ${GPT_SOVITS_PROVIDER_NAME}: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
    }
    const payload = await response.json().catch(() => null) as { task_id?: unknown; error?: unknown } | null;
    if (response.status === 401 || response.status === 403) {
      throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} rejected the request — check the gateway token setting`, 502);
    }
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `${GPT_SOVITS_PROVIDER_NAME} rejected the synthesis request`;
      throw new AudioGenerationError(message, 502);
    }
    const taskId = typeof payload?.task_id === "string" ? payload.task_id : "";
    if (!taskId) throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} returned no task id`, 502);
    return taskId;
  }

  async #collect(baseUrl: string, taskId: string, characters: number, signal?: AbortSignal): Promise<Uint8Array> {
    const absoluteDeadline = Date.now() + ABSOLUTE_TIMEOUT_MS;
    let synthesisDeadline: number | undefined;
    let lastStatus = "queued";
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      let response: Response;
      try {
        response = await this.request(`${baseUrl}/task/${encodeURIComponent(taskId)}`, {
          headers: this.#authHeaders(),
          signal: signal ?? undefined,
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new AudioGenerationError(`Lost contact with ${GPT_SOVITS_PROVIDER_NAME}: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
      }
      if (response.status === 401 || response.status === 403) {
        throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} rejected the request — check the gateway token setting`, 502);
      }
      if (!response.ok) throw new AudioGenerationError(`Could not read the ${GPT_SOVITS_PROVIDER_NAME} task status`, 502);
      const payload = await response.json().catch(() => null) as { status?: unknown; error?: unknown } | null;
      const status = typeof payload?.status === "string" ? payload.status : "unknown";
      lastStatus = status;
      if (status === "error") {
        const message = typeof payload?.error === "string" ? payload.error : "synthesis failed";
        throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} synthesis failed: ${message}`, 502);
      }
      if (status === "done") break;
      if (status === "running" && synthesisDeadline === undefined) {
        synthesisDeadline = Date.now() + Math.min(SYNTHESIS_TIMEOUT_CAP_MS, SYNTHESIS_BASE_MS + characters * SYNTHESIS_MS_PER_CHARACTER);
      }
      const deadline = synthesisDeadline ?? absoluteDeadline;
      if (Date.now() > deadline) {
        throw new AudioGenerationError(
          `${GPT_SOVITS_PROVIDER_NAME} task timed out (last status: ${lastStatus}; the gateway host may be memory constrained)`,
          504,
        );
      }
      if (Date.now() > absoluteDeadline) {
        throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} task exceeded the queue wait limit`, 504);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
    }
    let audio: Response;
    try {
      audio = await this.request(`${baseUrl}/task/${encodeURIComponent(taskId)}/audio`, {
        headers: this.#authHeaders(),
        signal: signal ?? undefined,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AudioGenerationError(`Could not download the ${GPT_SOVITS_PROVIDER_NAME} audio`, 502);
    }
    if (!audio.ok) throw new AudioGenerationError(`Could not download the ${GPT_SOVITS_PROVIDER_NAME} audio`, 502);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (!bytes.length) throw new AudioGenerationError(`${GPT_SOVITS_PROVIDER_NAME} returned no audio`, 502);
    return bytes;
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
