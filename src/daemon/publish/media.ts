import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflate, inflate } from "node:zlib";
import { PNG_SIGNATURE } from "../image-format.js";
import { projectProcessEnvironment } from "../project-process.js";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Recompress PNG scanlines without changing pixels, animation, or metadata. */
export async function compressPublishPng(bytes: Buffer): Promise<Buffer> {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes;
  const chunks: { type: string; bytes: Buffer }[] = [];
  const data: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return bytes;
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return bytes;
    const chunk = bytes.subarray(offset, end);
    if (crc32(chunk.subarray(4, -4)) !== chunk.readUInt32BE(chunk.length - 4))
      return bytes;
    const type = chunk.toString("ascii", 4, 8);
    chunks.push({ type, bytes: chunk });
    if (type === "IDAT") data.push(chunk.subarray(8, -4));
    offset = end;
  }
  if (!data.length || chunks.at(-1)?.type !== "IEND") return bytes;
  try {
    const raw = await inflateAsync(Buffer.concat(data), {
      maxOutputLength: MAX_IMAGE_BYTES,
    });
    const compressed = await deflateAsync(raw, { level: 9 });
    const idat = Buffer.alloc(compressed.length + 12);
    idat.writeUInt32BE(compressed.length);
    idat.write("IDAT", 4, "ascii");
    compressed.copy(idat, 8);
    idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4);
    const output: Buffer[] = [PNG_SIGNATURE];
    let written = false;
    for (const chunk of chunks) {
      if (chunk.type !== "IDAT") output.push(chunk.bytes);
      else if (!written) {
        output.push(idat);
        written = true;
      }
    }
    const result = Buffer.concat(output);
    return result.length < bytes.length ? result : bytes;
  } catch {
    return bytes;
  }
}

/** Temporary publish copies only; the Library and workspace always retain originals. */
export class PublishMediaOptimizer {
  readonly #files = new Map<string, string>();
  #temporary?: string;
  #encoderMissing = false;

  constructor(private readonly track: (child: ChildProcess) => void) {}

  async optimize(source: string): Promise<string> {
    const cached = this.#files.get(source);
    if (cached) return cached;
    const extension = path.extname(source).toLowerCase();
    if (extension !== ".png" && extension !== ".mp4") return source;
    const { size } = await stat(source);
    // Small assets do not justify a decode or a video encode.
    if (
      size < 256 * 1024 ||
      size > (extension === ".png" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)
    )
      return source;
    this.#temporary ??= await mkdtemp(
      path.join(tmpdir(), "ohmygame-publish-media-"),
    );
    const destination = path.join(
      this.#temporary,
      `${this.#files.size}${extension}`,
    );
    let result = source;
    if (extension === ".png") {
      const original = await readFile(source);
      const compressed = await compressPublishPng(original);
      if (compressed.length < original.length) {
        await writeFile(destination, compressed);
        result = destination;
      }
    } else if (
      !this.#encoderMissing &&
      (await this.#encodeVideo(source, destination))
    ) {
      const outputSize =
        (await stat(destination).catch(() => undefined))?.size ?? 0;
      if (outputSize > 0 && outputSize < size) result = destination;
    }
    this.#files.set(source, result);
    return result;
  }

  async close(): Promise<void> {
    if (this.#temporary)
      await rm(this.#temporary, { recursive: true, force: true });
  }

  async #encodeVideo(source: string, destination: string): Promise<boolean> {
    const child = spawn(
      process.env.OHMYGAME_FFMPEG_PATH || "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "passthrough",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        destination,
      ],
      {
        env: projectProcessEnvironment(),
        stdio: "ignore",
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    this.track(child);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 2 * 60_000);
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") this.#encoderMissing = true;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });
    });
  }
}
