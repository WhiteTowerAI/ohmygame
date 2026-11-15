import { createHash } from "node:crypto";

const FILE_BYTES = 100 * 1024 * 1024;
const BODY_BYTES = 200 * 1024 * 1024;
const TEXT_BYTES = 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export interface MediaFileReference {
  file: string;
  mediaType: string;
  byteLength: number;
}

/** Generation-owned snapshots. Only their content-bound handles cross into the VM. */
export class MediaInputFiles {
  readonly #files = new Map<
    string,
    { bytes: Buffer; mediaType: string; name: string }
  >();
  #bytes = 0;

  add(bytes: Buffer, mediaType: string, name: string): MediaFileReference {
    if (!bytes.length || bytes.length > FILE_BYTES)
      throw new Error("Media input must be between 1 byte and 100 MB");
    const file = createHash("sha256")
      .update(mediaType)
      .update("\0")
      .update(bytes)
      .digest("hex");
    if (!this.#files.has(file)) {
      if (this.#files.size >= 16 || this.#bytes + bytes.length > BODY_BYTES)
        throw new Error("Too many media input files");
      this.#files.set(file, { bytes: Buffer.from(bytes), mediaType, name });
      this.#bytes += bytes.length;
    }
    return { file, mediaType, byteLength: bytes.length };
  }

  #get(id: unknown) {
    const file = typeof id === "string" ? this.#files.get(id) : undefined;
    if (!file)
      throw new Error("Media input file is not available in this generation");
    return file;
  }

  /** Explicit JSON placeholders expand in the host, never inside QuickJS. */
  json(value: unknown): string {
    let size = 0,
      nodes = 0;
    const count = (bytes: number) => {
      size += bytes;
      if (size > BODY_BYTES)
        throw new Error("Media request body is larger than 200 MB");
    };
    const visit = (value: unknown, depth: number): unknown => {
      if (++nodes > 10_000 || depth > 64)
        throw new Error("Media request JSON is too complex");
      if (record(value) && "$mediaFile" in value) {
        if (
          Object.keys(value).some(
            (key) => !["$mediaFile", "mediaType"].includes(key),
          )
        )
          throw new Error("Invalid media file placeholder");
        const file = this.#get(value.$mediaFile);
        const type = value.mediaType ?? file.mediaType;
        if (
          typeof type !== "string" ||
          !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(type)
        )
          throw new Error("Invalid media file type");
        count(Math.ceil(file.bytes.length / 3) * 4 + type.length + 32);
        return `data:${type};base64,${file.bytes.toString("base64")}`;
      }
      if (Array.isArray(value)) {
        count(value.length + 2);
        return value.map((item) => visit(item, depth + 1));
      }
      if (record(value)) {
        count(2);
        const entries = Object.entries(value).map(([key, item]) => {
          count(Buffer.byteLength(JSON.stringify(key)) + 2);
          return [key, visit(item, depth + 1)] as const;
        });
        return Object.fromEntries(entries);
      }
      count(Buffer.byteLength(JSON.stringify(value) ?? "null") + 1);
      return value;
    };
    return JSON.stringify(visit(value, 0));
  }

  /** Repeated field names are intentional (for example Hyper3D's images). */
  multipart(value: unknown): FormData {
    if (!Array.isArray(value) || !value.length || value.length > 64)
      throw new Error("Multipart needs 1 to 64 fields");
    const form = new FormData();
    let bytes = 0,
      textBytes = 0;
    for (const part of value) {
      if (
        !record(part) ||
        typeof part.name !== "string" ||
        !part.name.length ||
        part.name.length > 200 ||
        /[\r\n\0]/.test(part.name)
      )
        throw new Error("Invalid multipart field");
      if ("file" in part) {
        if (
          Object.keys(part).some(
            (key) => !["name", "file", "filename"].includes(key),
          )
        )
          throw new Error("Invalid multipart file field");
        const file = this.#get(part.file),
          name = part.filename ?? file.name;
        if (
          typeof name !== "string" ||
          !/^[a-zA-Z0-9_.-]{1,200}$/.test(name) ||
          name === "." ||
          name === ".."
        )
          throw new Error("Invalid multipart filename");
        bytes += file.bytes.length;
        if (bytes + textBytes > BODY_BYTES)
          throw new Error("Media request body is larger than 200 MB");
        form.append(
          part.name,
          new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
          name,
        );
      } else {
        if (
          Object.keys(part).some((key) => !["name", "value"].includes(key)) ||
          typeof part.value !== "string"
        )
          throw new Error("Invalid multipart text field");
        textBytes += Buffer.byteLength(part.value);
        if (textBytes > TEXT_BYTES || bytes + textBytes > BODY_BYTES)
          throw new Error("Multipart text is too large");
        form.append(part.name, part.value);
      }
    }
    return form;
  }
}
