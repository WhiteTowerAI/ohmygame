import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import yazl from "yazl";
import { MAX_MEDIA_FRAMES, MAX_MEDIA_OUTPUT_BYTES, MAX_MEDIA_TOTAL_PIXELS } from "../shared/media-tools.js";
import { readMediaDimensions } from "./media-dimensions.js";

const execFileAsync = promisify(execFile);
const MAX_PIXELS = 100_000_000;
const MAX_FRAMES = MAX_MEDIA_FRAMES;
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"] as const);
const require = createRequire(import.meta.url);
const MAX_MEDIA_TASKS = 2;
const MAX_QUEUED_MEDIA_TASKS = 8;
let activeMediaTasks = 0;
const waitingMediaTasks: Array<() => void> = [];

export class MediaLimitError extends Error {
  constructor(message: string, readonly statusCode: number = 413) { super(message); }
}

export async function withMediaTask<T>(operation: () => Promise<T>): Promise<T> {
  if (activeMediaTasks >= MAX_MEDIA_TASKS) {
    if (waitingMediaTasks.length >= MAX_QUEUED_MEDIA_TASKS) throw new MediaLimitError("Too many media operations are queued", 429);
    await new Promise<void>((resolve) => waitingMediaTasks.push(resolve));
  } else activeMediaTasks += 1;
  try {
    return await operation();
  } finally {
    const next = waitingMediaTasks.shift();
    if (next) next();
    else activeMediaTasks -= 1;
  }
}

function checkPixelBudget(pixels: number): void {
  if (!Number.isSafeInteger(pixels) || pixels > MAX_MEDIA_TOTAL_PIXELS)
    throw new MediaLimitError("Media input exceeds the 64 megapixel processing limit");
}

async function inputPixels(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const source of paths) {
    const metadata = await sharp(source, { animated: false, limitInputPixels: MAX_PIXELS }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("Could not read image dimensions");
    total += metadata.width * metadata.height;
    checkPixelBudget(total);
  }
  return total;
}
function ffmpegExecutable(): string {
  if (process.env.OHMYGAME_FFMPEG_PATH) return process.env.OHMYGAME_FFMPEG_PATH;
  try {
    const binary = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
    return binary.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  } catch {
    return "ffmpeg";
  }
}

export interface SingleImageOptions {
  inputPath: string;
  format?: ImageOutputFormat;
}

function imageOutput(
  name: string,
  bytes: Buffer,
  format: ImageOutputFormat,
): MediaOutput {
  return { name, bytes, mediaType: mediaTypeFor(format) };
}

function addBoundedOutput(outputs: MediaOutput[], output: MediaOutput): void {
  const bytes = outputs.reduce((total, item) => total + item.bytes.byteLength, output.bytes.byteLength);
  if (bytes > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media output exceeds 128 MiB");
  outputs.push(output);
}

function boundedOutput(output: MediaOutput): MediaOutput {
  if (output.bytes.byteLength > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media output exceeds 128 MiB");
  return output;
}

export async function cropImage(
  options: SingleImageOptions & {
    left: number;
    top: number;
    width: number;
    height: number;
  },
): Promise<MediaOutput> {
  const format = options.format ?? "png";
  assertImageFormat(format);
  await inputPixels([options.inputPath]);
  const bytes = await sharp(options.inputPath, { limitInputPixels: MAX_PIXELS })
    .autoOrient()
    .extract({
      left: options.left,
      top: options.top,
      width: options.width,
      height: options.height,
    })
    .toFormat(format)
    .toBuffer();
  return boundedOutput(imageOutput(`cropped.${extensionFor(format)}`, bytes, format));
}

export async function extractGifFrames(
  options: SingleImageOptions,
): Promise<MediaOutput[]> {
  const source = sharp(options.inputPath, {
    animated: true,
    limitInputPixels: MAX_PIXELS,
  });
  const metadata = await source.metadata();
  if (metadata.format !== "gif")
    throw new Error("GIF extraction requires a GIF image");
  const count = metadata.pages ?? 1;
  if (count > MAX_FRAMES)
    throw new Error(`GIF contains too many frames (maximum ${MAX_FRAMES})`);
  checkPixelBudget((metadata.width ?? 0) * (metadata.pageHeight ?? metadata.height ?? 0) * count);
  const outputs: MediaOutput[] = [];
  for (let page = 0; page < count; page++) {
    const bytes = await sharp(options.inputPath, {
      page,
      pages: 1,
      limitInputPixels: MAX_PIXELS,
    })
      .png()
      .toBuffer();
    addBoundedOutput(outputs, imageOutput(`frame-${String(page).padStart(4, "0")}.png`, bytes, "png"));
  }
  return outputs;
}

export const composeGif = (
  framePaths: string[],
  fps = 12,
  signal?: AbortSignal,
) => composeVideo({ framePaths, fps, format: "gif", signal });

export interface ImageLayer {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  visible: boolean;
}

export async function composeImageLayers(options: {
  inputPaths: string[];
  layers: ImageLayer[];
  width: number;
  height: number;
}): Promise<MediaOutput> {
  assertInteger(options.width, 1, 16_384, "width");
  assertInteger(options.height, 1, 16_384, "height");
  if (options.width * options.height > MAX_PIXELS) throw new Error("Layer canvas is too large");
  if (options.inputPaths.length < 1 || options.inputPaths.length > 100 || options.layers.length !== options.inputPaths.length)
    throw new Error("Layers must match 1-100 input images");
  checkPixelBudget(options.width * options.height);
  await inputPixels(options.inputPaths.filter((_, index) => options.layers[index]?.visible && options.layers[index]?.opacity !== 0));
  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  let scaledPixels = 0;
  let layerBytes = 0;
  for (let index = 0; index < options.inputPaths.length; index++) {
    const inputPath = options.inputPaths[index]!;
    const layer = options.layers[index]!;
    assertInteger(layer.x, -16_384, 16_384, "layer.x");
    assertInteger(layer.y, -16_384, 16_384, "layer.y");
    assertRange(layer.scale, 0.05, 8, "layer.scale");
    assertRange(layer.opacity, 0, 1, "layer.opacity");
    if (typeof layer.visible !== "boolean") throw new Error("layer.visible must be a boolean");
    if (!layer.visible || layer.opacity === 0) continue;
    const source = sharp(inputPath, { animated: false, limitInputPixels: MAX_PIXELS }).autoOrient();
    const metadata = await source.metadata();
    const dimensions = metadata.autoOrient ?? metadata;
    if (!dimensions.width || !dimensions.height) throw new Error("Could not read layer dimensions");
    const width = Math.max(1, Math.round(dimensions.width * layer.scale));
    const height = Math.max(1, Math.round(dimensions.height * layer.scale));
    scaledPixels += width * height;
    checkPixelBudget(scaledPixels);
    assertDimension(width, "layer width");
    assertDimension(height, "layer height");
    if (width * height > MAX_PIXELS) throw new Error("Scaled layer is too large");
    const left = Math.max(0, layer.x);
    const top = Math.max(0, layer.y);
    const cropWidth = Math.min(width - (left - layer.x), options.width - left);
    const cropHeight = Math.min(height - (top - layer.y), options.height - top);
    if (cropWidth <= 0 || cropHeight <= 0) continue;
    const { data, info } = await source.resize(width, height, { fit: "fill" })
      .extract({ left: left - layer.x, top: top - layer.y, width: cropWidth, height: cropHeight })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (layer.opacity < 1) for (let offset = 3; offset < data.length; offset += info.channels)
      data[offset] = Math.round(data[offset]! * layer.opacity);
    const input = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
    layerBytes += input.byteLength;
    if (layerBytes > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media intermediate images exceed 128 MiB");
    layers.push({ input, left, top });
  }
  return boundedOutput(imageOutput("composed-layers.png", await sharp({
    create: { width: options.width, height: options.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(layers).png().toBuffer(), "png"));
}

export type ImageOutputFormat = "png" | "jpeg" | "webp";

export interface MediaOutput {
  name: string;
  bytes: Buffer;
  mediaType: string;
}

export interface GridSplitOptions {
  inputPath: string;
  columns: number;
  rows: number;
  format?: ImageOutputFormat;
  includeManifest?: boolean;
  selectedFrames?: number[];
}

/** Splits a sprite sheet into row-major cells and returns frame files plus a manifest. */
export async function splitImageGrid(
  options: GridSplitOptions,
): Promise<MediaOutput[]> {
  assertInteger(options.columns, 1, 100, "columns");
  assertInteger(options.rows, 1, 100, "rows");
  const count = options.columns * options.rows;
  if (count > MAX_FRAMES)
    throw new Error(`Grid contains too many cells (maximum ${MAX_FRAMES})`);
  const selected = options.selectedFrames ?? Array.from({ length: count }, (_, index) => index);
  if (!selected.length || selected.length > count || selected.some((index, position) => !Number.isInteger(index) || index < 0 || index >= count || (position > 0 && index <= selected[position - 1]!)))
    throw new Error("selectedFrames must contain unique cell indices in ascending order");
  const selectedSet = new Set(selected);
  const format = options.format ?? "png";
  assertImageFormat(format);
  const source = sharp(options.inputPath, {
    animated: false,
    limitInputPixels: MAX_PIXELS,
  }).autoOrient();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("Could not read image dimensions");
  const dimensions = metadata.autoOrient ?? metadata;
  checkPixelBudget(dimensions.width * dimensions.height);
  const columnEdges = gridEdges(dimensions.width, options.columns);
  const rowEdges = gridEdges(dimensions.height, options.rows);
  const columnWidths = columnEdges
    .slice(1)
    .map((edge, index) => edge - columnEdges[index]!);
  const rowHeights = rowEdges
    .slice(1)
    .map((edge, index) => edge - rowEdges[index]!);
  const uniformWidth = new Set(columnWidths).size === 1;
  const uniformHeight = new Set(rowHeights).size === 1;
  if (
    columnWidths.some((width) => width < 1) ||
    rowHeights.some((height) => height < 1)
  )
    throw new Error("Grid cells must be at least one pixel");
  const outputs: MediaOutput[] = [];
  for (let row = 0; row < options.rows; row += 1) {
    for (let column = 0; column < options.columns; column += 1) {
      const index = row * options.columns + column;
      if (!selectedSet.has(index)) continue;
      const bytes = await source
        .clone()
        .extract({
          left: columnEdges[column]!,
          top: rowEdges[row]!,
          width: columnWidths[column]!,
          height: rowHeights[row]!,
        })
        .toFormat(format)
        .toBuffer();
      addBoundedOutput(outputs, {
        name: `frame-${String(index).padStart(4, "0")}.${extensionFor(format)}`,
        bytes,
        mediaType: mediaTypeFor(format),
      });
    }
  }
  if (options.includeManifest !== false) {
    addBoundedOutput(outputs, {
      name: "manifest.json",
      bytes: Buffer.from(
        JSON.stringify(
          {
            columns: options.columns,
            rows: options.rows,
            ...(uniformWidth ? { cellWidth: columnWidths[0] } : {}),
            ...(uniformHeight ? { cellHeight: rowHeights[0] } : {}),
            columnWidths,
            rowHeights,
            frames: count,
            selectedFrames: selected,
          },
          null,
          2,
        ),
      ),
      mediaType: "application/json",
    });
  }
  return outputs;
}

export interface ExtractFramesOptions {
  inputPath: string;
  fps?: number;
  startTime?: number;
  duration?: number;
  format?: "png" | "jpg";
  includeManifest?: boolean;
  selectedFrames?: number[];
  signal?: AbortSignal;
}

/** Extracts bounded video frames with FFmpeg. The returned files are ordered by frame number. */
export async function extractVideoStrip(
  options: ExtractFramesOptions,
): Promise<MediaOutput[]> {
  assertRange(options.fps, 0.1, 120, "fps");
  assertRange(options.startTime, 0, 86_400, "startTime");
  assertRange(options.duration, 0.01, 300, "duration");
  const selected = options.selectedFrames;
  if (selected && (!selected.length || selected.some((index, position) => !Number.isInteger(index) || index < 0 || index >= MAX_FRAMES || (position > 0 && index <= selected[position - 1]!))))
    throw new Error("selectedFrames must contain unique frame indices in ascending order");
  const format = options.format ?? "png";
  if (format !== "png" && format !== "jpg")
    throw new Error(`Unsupported frame format: ${format}`);
  const dimensions = await readMediaDimensions(options.inputPath);
  if (dimensions) checkPixelBudget(dimensions.width * dimensions.height);
  const extension = format === "jpg" ? "jpg" : "png";
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "ohmygame-video-frames-"),
  );
  try {
    const pattern = path.join(temporary, `frame-%06d.${extension}`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      options.inputPath,
    ];
    if (options.startTime !== undefined)
      args.push("-ss", String(options.startTime));
    if (options.duration !== undefined)
      args.push("-t", String(options.duration));
    args.push(
      "-vf",
      `fps=${options.fps ?? 12}`,
      "-frames:v",
      String(MAX_FRAMES),
      "-vsync",
      "0",
      pattern,
    );
    await runFfmpeg(args, options.signal, temporary);
    if (await temporaryBytes(temporary) > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media temporary files exceed 128 MiB");
    const files = (await readdir(temporary))
      .filter((file) => file.endsWith(`.${extension}`))
      .sort();
    if (!files.length) throw new Error("FFmpeg produced no frames");
    const selectedSet = selected ? new Set(selected) : undefined;
    const indices = files.map((_, index) => index).filter((index) => !selectedSet || selectedSet.has(index));
    if (!indices.length) throw new Error("No selected frames exist in this video range");
    const outputs: MediaOutput[] = [];
    let outputBytes = 0;
    let pixels = 0;
    for (const index of indices) {
      const file = path.join(temporary, files[index]!);
      outputBytes += (await stat(file)).size;
      if (outputBytes > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media output exceeds 128 MiB");
      const metadata = await sharp(file, { limitInputPixels: MAX_PIXELS }).metadata();
      pixels += (metadata.width ?? 0) * (metadata.height ?? 0);
      checkPixelBudget(pixels);
      addBoundedOutput(outputs, {
        name: `frame-${String(index).padStart(4, "0")}.${extension}`,
        bytes: await readFile(file),
        mediaType: extension === "jpg" ? "image/jpeg" : "image/png",
      });
    }
    if (options.includeManifest !== false) {
      const fps = options.fps ?? 12;
      addBoundedOutput(outputs, {
        name: "manifest.json",
        bytes: Buffer.from(
          JSON.stringify(
            {
              version: 1,
              fps,
              startTime: options.startTime ?? 0,
              ...(options.duration !== undefined
                ? { duration: options.duration }
                : {}),
              frames: outputs.map((output, position) => ({
                i: indices[position],
                name: output.name,
                t: Number(((options.startTime ?? 0) + indices[position]! / fps).toFixed(6)),
              })),
            },
            null,
            2,
          ),
        ),
        mediaType: "application/json",
      });
    }
    return outputs;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface ComposeVideoOptions {
  framePaths: string[];
  fps?: number;
  format?: "mp4" | "gif";
  signal?: AbortSignal;
}

/** Composes a numbered sequence of image files into an MP4 or GIF with FFmpeg. */
export async function composeVideo(
  options: ComposeVideoOptions,
): Promise<MediaOutput> {
  if (!options.framePaths.length || options.framePaths.length > MAX_FRAMES)
    throw new Error(`framePaths must contain 1-${MAX_FRAMES} files`);
  assertRange(options.fps, 0.1, 120, "fps");
  const format = options.format ?? "mp4";
  if (format !== "mp4" && format !== "gif")
    throw new Error(`Unsupported video format: ${format}`);
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "ohmygame-video-compose-"),
  );
  try {
    await inputPixels(options.framePaths);
    const dimensions = await Promise.all(options.framePaths.map(async (source) => {
      const metadata = await sharp(source, { animated: false, limitInputPixels: MAX_PIXELS }).metadata();
      const displayed = metadata.autoOrient ?? metadata;
      if (!displayed.width || !displayed.height) throw new Error("Could not read frame dimensions");
      return { width: displayed.width, height: displayed.height };
    }));
    const maxWidth = Math.max(...dimensions.map((frame) => frame.width));
    const maxHeight = Math.max(...dimensions.map((frame) => frame.height));
    // Rounded grid boundaries can produce cells differing by one pixel.
    // Preserve their local coordinates instead of resizing each cell's pixels.
    const preserveGridPixels = dimensions.every((frame) => maxWidth - frame.width <= 1 && maxHeight - frame.height <= 1);
    const canvasWidth = preserveGridPixels ? maxWidth : dimensions[0]!.width;
    const canvasHeight = preserveGridPixels ? maxHeight : dimensions[0]!.height;
    const width = format === "mp4" ? canvasWidth + (canvasWidth % 2) : canvasWidth;
    const height = format === "mp4" ? canvasHeight + (canvasHeight % 2) : canvasHeight;
    checkPixelBudget(width * height * options.framePaths.length);
    for (let start = 0; start < options.framePaths.length; start += 2) {
      await Promise.all(options.framePaths.slice(start, start + 2).map(async (source, offset) => {
        const index = start + offset;
        const image = sharp(source, {
          animated: false,
          limitInputPixels: MAX_PIXELS,
        }).autoOrient();
        const normalized = preserveGridPixels
          ? image.extend({
              top: 0, left: 0,
              bottom: height - dimensions[index]!.height,
              right: width - dimensions[index]!.width,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
          : image.resize({
              width, height, fit: "contain",
              background: { r: 0, g: 0, b: 0, alpha: 0 },
              withoutEnlargement: false,
            });
        await normalized
          // Padding can add alpha to only some frames. Keep a stable pixel
          // format so FFmpeg does not reset its palette filter mid-sequence.
          .ensureAlpha()
          .png()
          .toFile(
            path.join(temporary, `frame-${String(index + 1).padStart(6, "0")}.png`),
          );
      }));
      if (await temporaryBytes(temporary) > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media temporary files exceed 128 MiB");
    }
    const output = path.join(temporary, `output.${format}`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      String(options.fps ?? 12),
      "-i",
      path.join(temporary, "frame-%06d.png"),
    ];
    // Diff sampling can omit colors used only by a later frame.
    if (format === "gif")
      args.push(
        "-filter_complex",
        "[0:v]split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a",
        // Cropped offsets and transparent difference frames can lose opaque
        // regions during disposal. Encode complete frames with their actual alpha.
        "-gifflags",
        "-offsetting-transdiff",
        "-loop",
        "0",
      );
    else
      args.push(
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
      );
    args.push("-y", output);
    await runFfmpeg(args, options.signal, temporary);
    if (await temporaryBytes(temporary) > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media temporary files exceed 128 MiB");
    if ((await stat(output)).size > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media output exceeds 128 MiB");
    return boundedOutput({
      name: `composed.${format}`,
      bytes: await readFile(output),
      mediaType: format === "gif" ? "image/gif" : "video/mp4",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function zipMediaOutputs(
  outputs: readonly MediaOutput[],
): Promise<Buffer> {
  if (outputs.reduce((total, output) => total + output.bytes.byteLength, 0) > MAX_MEDIA_OUTPUT_BYTES)
    throw new MediaLimitError("Media output exceeds 128 MiB");
  const zip = new yazl.ZipFile();
  for (const output of outputs) zip.addBuffer(output.bytes, output.name);
  const chunks: Buffer[] = [];
  let archiveBytes = 0;
  const stream = zip.outputStream as AsyncIterable<Buffer>;
  const done = (async () => {
    for await (const chunk of stream) {
      archiveBytes += chunk.byteLength;
      if (archiveBytes > MAX_MEDIA_OUTPUT_BYTES) throw new MediaLimitError("Media output exceeds 128 MiB");
      chunks.push(Buffer.from(chunk));
    }
  })();
  zip.end();
  await done;
  return Buffer.concat(chunks, archiveBytes);
}

function gridEdges(size: number, cells: number): number[] {
  return Array.from({ length: cells + 1 }, (_, index) =>
    Math.round((index * size) / cells),
  );
}

function assertImageFormat(
  format: string,
): asserts format is ImageOutputFormat {
  if (!IMAGE_FORMATS.has(format as ImageOutputFormat))
    throw new Error(`Unsupported image format: ${format}`);
}

function assertDimension(value: number | undefined, name: string): void {
  if (value !== undefined) assertInteger(value, 1, 16_384, name);
}

function assertInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
}

function assertRange(
  value: number | undefined,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < minimum || value > maximum)
  )
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
}

function extensionFor(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}
function mediaTypeFor(format: ImageOutputFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}



async function temporaryBytes(directory: string): Promise<number> {
  const files = await readdir(directory);
  let total = 0;
  for (const file of files) total += (await stat(path.join(directory, file))).size;
  return total;
}

async function runFfmpeg(args: string[], signal?: AbortSignal, temporary?: string): Promise<void> {
  if (signal?.aborted) throw new Error("Operation cancelled");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let exceeded = false;
    let checking = false;
    const monitor = temporary ? setInterval(() => {
      if (checking) return;
      checking = true;
      void temporaryBytes(temporary).then((bytes) => {
        if (bytes > MAX_MEDIA_OUTPUT_BYTES) {
          exceeded = true;
          child.kill("SIGTERM");
        }
      }).catch(() => undefined).finally(() => { checking = false; });
    }, 100) : undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (monitor) clearInterval(monitor);
      signal?.removeEventListener("abort", abort);
      reject(new Error(`FFmpeg is unavailable: ${error.message}`));
    });
    child.once("close", (code) => {
      if (monitor) clearInterval(monitor);
      signal?.removeEventListener("abort", abort);
      if (exceeded) reject(new MediaLimitError("Media temporary files exceed 128 MiB"));
      else if (signal?.aborted) reject(new Error("Operation cancelled"));
      else if (code !== 0)
        reject(
          new Error(
            stderr.trim() || `FFmpeg exited with code ${code ?? "unknown"}`,
          ),
        );
      else resolve();
    });
  });
}

export async function assertFfmpegAvailable(): Promise<void> {
  await execFileAsync(ffmpegExecutable(), ["-version"], { timeout: 5_000 });
}
