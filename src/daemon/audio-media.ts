import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import type {
  AudioOutputFormat,
  AudioSentence,
  AudioSubtitles,
  AudioWord,
} from "../shared/audio.js";
import { AudioGenerationError } from "./audio-generation.js";

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export function decodeAudioBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  if (
    !normalized ||
    normalized.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  )
    throw new AudioGenerationError("Provider returned invalid audio data", 502);
  const bytes = Buffer.from(normalized, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_AUDIO_BYTES ||
    bytes.toString("base64") !== normalized
  )
    throw new AudioGenerationError("Provider returned invalid audio data", 502);
  return bytes;
}

/** Demux the actual content instead of trusting the file name or uploaded duration. */
export async function inspectAudio(
  bytes: Uint8Array,
  expected?: AudioOutputFormat,
  statusCode = 400,
) {
  const input = new Input({
    source: new BufferSource(bytes),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || (await input.getVideoTracks()).length)
      throw new Error("Expected an audio-only file");
    const codec = await track.getCodec();
    const mime = await input.getMimeType();
    if (
      (expected === "mp3" && codec !== "mp3") ||
      (expected === "wav" && !mime.includes("wav")) ||
      (expected === "ogg_opus" && (!mime.includes("ogg") || codec !== "opus"))
    )
      throw new Error(`Expected ${expected} audio`);
    const duration = await track.computeDuration();
    const stats = await track.computePacketStats();
    if (!Number.isFinite(duration) || duration <= 0 || !stats.packetCount)
      throw new Error("Audio contains no playable samples");
    return {
      durationMs: Math.round(duration * 1000),
      sampleRate: await track.getSampleRate(),
      channels: await track.getNumberOfChannels(),
      codec: codec ?? "unknown",
      mime,
    };
  } catch (cause) {
    throw new AudioGenerationError(
      `Invalid ${expected ?? "reference"} audio: ${cause instanceof Error ? cause.message : String(cause)}`,
      statusCode,
    );
  } finally {
    input.dispose();
  }
}

export function audioRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(300_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readAudioJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body)
    throw new AudioGenerationError("Provider returned an empty response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 8 * 1024 * 1024)
        throw new Error("Audio response is too large");
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Expected a JSON object");
    return result as Record<string, unknown>;
  } catch (cause) {
    await reader.cancel().catch(() => {});
    throw new AudioGenerationError(
      `Could not read audio response: ${cause instanceof Error ? cause.message : String(cause)}`,
      502,
    );
  } finally {
    reader.releaseLock();
  }
}

export function subtitleWord(value: unknown, milliseconds: boolean): AudioWord {
  if (!value || typeof value !== "object")
    throw new AudioGenerationError("Invalid subtitle entry", 502);
  const item = value as Record<string, unknown>;
  const start =
    Number(milliseconds ? item.start_time : item.startTime) *
    (milliseconds ? 1 : 1000);
  const end =
    Number(milliseconds ? item.end_time : item.endTime) *
    (milliseconds ? 1 : 1000);
  const text = milliseconds ? item.text : item.word;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    typeof text !== "string"
  )
    throw new AudioGenerationError("Invalid subtitle timing", 502);
  return {
    text,
    startMs: Math.round(start),
    endMs: Math.round(end),
    ...(typeof item.confidence === "number"
      ? { confidence: item.confidence }
      : {}),
  };
}

export function seedSubtitles(value: unknown): AudioSubtitles | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as { text?: unknown; sentences?: unknown };
  if (!Array.isArray(item.sentences)) return;
  const sentences: AudioSentence[] = item.sentences.map((value) => {
    const sentence = subtitleWord(value, true);
    return {
      ...sentence,
      ...(Array.isArray(value.words)
        ? {
            words: value.words.map((word: unknown) => subtitleWord(word, true)),
          }
        : {}),
    };
  });
  return {
    text:
      typeof item.text === "string"
        ? item.text
        : sentences.map((sentence) => sentence.text).join(""),
    sentences,
  };
}

/**
 * Doubao codes starting with 4 are request errors and 5 are service errors;
 * concurrency and entitlement failures are reported by message.
 */
export function doubaoErrorStatus(code: number, message = ""): number {
  if (/quota exceeded|concurrency/i.test(message)) return 429;
  if (
    /permission denied|access denied|resource ID is mismatched|requested grant not found/i.test(
      message,
    )
  )
    return 503;
  return String(code).startsWith("4") ? 400 : 502;
}

export async function audioHttpError(
  response: Response,
  provider: string,
): Promise<AudioGenerationError> {
  let detail = "";
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 2048) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value.subarray(0, 2048 - size));
        size += value.length;
      }
      detail = Buffer.concat(chunks).toString("utf8").trim();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  let code: number | undefined;
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed.message === "string") detail = parsed.message;
    if (Number.isInteger(parsed.code) && parsed.code > 0) code = parsed.code;
  } catch {
    /* Provider may return plain text. */
  }
  const status =
    response.status === 401 || response.status === 403
      ? 503
      : response.status === 429
        ? 429
        : code !== undefined
          ? doubaoErrorStatus(code, detail)
          : response.status >= 500
            ? 502
            : 400;
  return new AudioGenerationError(
    `${provider}: ${detail || `request failed (${response.status})`}`,
    status,
  );
}

export function validateControl(
  value: number | undefined,
  min: number,
  max: number,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < min || value > max)
  )
    throw new AudioGenerationError(
      `${name} must be an integer between ${min} and ${max}`,
      400,
    );
}
