import { decodeAudioBase64, MAX_AUDIO_BYTES } from "./audio-media.js";

type Field = string | string[];

/** Audio in one JSON object or a stream of JSON lines; existing adapters default to Base64. */
export interface AudioResponseEncoding {
  format: "json" | "jsonl";
  encoding?: "base64" | "hex";
  audioField: Field;
  statusField: Field;
  messageField?: Field;
  successCodes: number[];
}

const METADATA_BYTES = 8 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const parts = (field: Field): string[] =>
  typeof field === "string" ? [field] : field;
const validField = (value: unknown): value is Field => {
  if (typeof value === "string")
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
  const fields = value;
  return (
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.length <= 4 &&
    fields.every(
      (field) =>
        typeof field === "string" &&
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) &&
        !["constructor", "prototype", "__proto__"].includes(field),
    )
  );
};
const overlaps = (a: Field, b: Field): boolean => {
  const left = parts(a),
    right = parts(b);
  return left
    .slice(0, Math.min(left.length, right.length))
    .every((field, index) => field === right[index]);
};
function fieldValue(value: unknown, field: Field): unknown {
  for (const key of parts(field)) {
    if (!object(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
function withoutField(
  value: Record<string, unknown>,
  field: Field,
): Record<string, unknown> {
  const result = { ...value };
  let current = result;
  const path = parts(field);
  for (const key of path.slice(0, -1)) {
    const child = Object.hasOwn(current, key) ? current[key] : undefined;
    if (!object(child)) return result;
    current[key] = { ...child };
    current = current[key] as Record<string, unknown>;
  }
  delete current[path.at(-1)!];
  return result;
}

/** Adapter input is untrusted; paths are bounded lists of own field names, never expressions. */
export function audioResponseEncoding(value: unknown): AudioResponseEncoding {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "format",
          "encoding",
          "audioField",
          "statusField",
          "messageField",
          "successCodes",
        ].includes(key),
    ) ||
    (value.format !== "json" && value.format !== "jsonl") ||
    (value.encoding !== undefined &&
      value.encoding !== "base64" &&
      value.encoding !== "hex") ||
    !validField(value.audioField) ||
    !validField(value.statusField) ||
    (value.messageField !== undefined && !validField(value.messageField)) ||
    overlaps(value.audioField, value.statusField) ||
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
  const encodedLimit =
    (encoding.encoding === "hex" ? maxBytes * 2 : Math.ceil(maxBytes / 3) * 4) +
    8 * 1024 * 1024;
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
    const status = fieldValue(event, encoding.statusField);
    if (!object(event) || !Number.isSafeInteger(status))
      throw new Error("Encoded audio response has no valid status");
    if (!encoding.successCodes.includes(status as number)) {
      const detail = fieldValue(event, encoding.messageField ?? "message");
      const message =
        typeof detail === "string" ? `: ${detail.slice(0, 1000)}` : "";
      throw new Error(`Audio response failed with code ${status}${message}`);
    }
    const audio = fieldValue(event, encoding.audioField);
    const rest = withoutField(event, encoding.audioField);
    // Successful JSONL metadata and completion events can carry a null audio field.
    if (audio !== undefined && audio !== "" && !(encoding.format === "jsonl" && audio === null)) {
      if (typeof audio !== "string")
        throw new Error("Invalid encoded audio field");
      if (
        encoding.encoding === "hex" &&
        (audio.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(audio))
      )
        throw new Error("Invalid hexadecimal audio field");
      const bytes =
        encoding.encoding === "hex"
          ? Buffer.from(audio, "hex")
          : decodeAudioBase64(audio);
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
