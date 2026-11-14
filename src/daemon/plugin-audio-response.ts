import { decodeAudioBase64, MAX_AUDIO_BYTES } from "./audio-media.js";

/** A top-level Base64 audio field in one JSON object or a stream of JSON lines. */
export interface AudioResponseEncoding {
  format: "json" | "jsonl";
  audioField: string;
  statusField: string;
  successCodes: number[];
}

const METADATA_BYTES = 8 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Adapter input is untrusted; these are field names, never paths or expressions. */
export function audioResponseEncoding(value: unknown): AudioResponseEncoding {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["format", "audioField", "statusField", "successCodes"].includes(key),
    ) ||
    (value.format !== "json" && value.format !== "jsonl") ||
    typeof value.audioField !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.audioField) ||
    typeof value.statusField !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.statusField) ||
    value.audioField === value.statusField ||
    !Array.isArray(value.successCodes) ||
    !value.successCodes.length ||
    value.successCodes.length > 8 ||
    value.successCodes.some((code) => !Number.isSafeInteger(code))
  )
    throw new Error("Invalid audio response encoding");
  return value as unknown as AudioResponseEncoding;
}

/** Decode outside the VM, retaining only bounded non-audio metadata in the receipt. */
export async function readEncodedAudio(
  response: Response,
  encoding: AudioResponseEncoding,
  maxBytes = MAX_AUDIO_BYTES,
): Promise<{ bytes: Buffer; metadata: Record<string, unknown> }> {
  const encodedLimit = Math.ceil(maxBytes / 3) * 4 + 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > encodedLimit) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Encoded audio response is too large");
  }
  if (!response.body) throw new Error("Empty encoded audio response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let size = 0,
    received = 0,
    pending = "";
  let metadata: Record<string, unknown> = {};
  const consume = (text: string) => {
    if (!text.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      throw new Error("Invalid encoded audio JSON");
    }
    if (
      !object(event) ||
      !Object.hasOwn(event, encoding.statusField) ||
      !Number.isSafeInteger(event[encoding.statusField])
    )
      throw new Error("Encoded audio response has no valid status");
    if (
      !encoding.successCodes.includes(event[encoding.statusField] as number)
    ) {
      const message =
        typeof event.message === "string"
          ? `: ${event.message.slice(0, 1000)}`
          : "";
      throw new Error(
        `Audio response failed with code ${event[encoding.statusField]}${message}`,
      );
    }
    const { [encoding.audioField]: audio, ...rest } = event;
    if (audio !== undefined && audio !== "") {
      if (typeof audio !== "string")
        throw new Error("Invalid encoded audio field");
      const bytes = decodeAudioBase64(audio);
      size += bytes.byteLength;
      if (size > maxBytes)
        throw new Error("Decoded audio response is too large");
      chunks.push(bytes);
    }
    metadata = { ...metadata, ...rest };
    if (Buffer.byteLength(JSON.stringify(metadata)) > METADATA_BYTES)
      throw new Error("Encoded audio metadata is too large");
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > encodedLimit)
        throw new Error("Encoded audio response is too large");
      pending += decoder.decode(value, { stream: true });
      if (encoding.format === "jsonl") {
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          consume(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      }
    }
    pending += decoder.decode();
    consume(pending);
    if (!size) throw new Error("Encoded audio response contains no audio");
    return { bytes: Buffer.concat(chunks, size), metadata };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
