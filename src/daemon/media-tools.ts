import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import yazl from "yazl";

const execFileAsync = promisify(execFile);
const MAX_PIXELS = 100_000_000;
const MAX_FRAMES = 1_000;
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"] as const);
const require = createRequire(import.meta.url);

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

export interface BackgroundRemovalOptions extends SingleImageOptions {
  tolerance?: number;
}

function imageOutput(
  name: string,
  bytes: Buffer,
  format: ImageOutputFormat,
): MediaOutput {
  return { name, bytes, mediaType: mediaTypeFor(format) };
}

/** Removes pixels matching the selected chroma-key color. */
async function removeColorBackground(
  options: BackgroundRemovalOptions & { color: "green" | "blue" | "white" },
): Promise<MediaOutput> {
  const format = options.format ?? "png";
  assertTransparentFormat(format);
  const { data, info } = await sharp(options.inputPath, {
    limitInputPixels: MAX_PIXELS,
  })
    .autoOrient()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tolerance = options.tolerance ?? 48;
  assertInteger(tolerance, 0, 255, "tolerance");
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = [data[index]!, data[index + 1]!, data[index + 2]!];
    const match =
      options.color === "green"
        ? g > r * 1.18 && g > b * 1.12 && g - Math.max(r, b) >= tolerance
        : options.color === "blue"
          ? b > r * 1.15 && b > g * 1.08 && b - Math.max(r, g) >= tolerance
          : Math.min(r, g, b) >= 255 - tolerance;
    if (match) data[index + 3] = 0;
  }
  const bytes = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .toFormat(format)
    .toBuffer();
  return imageOutput(
    `background-removed.${extensionFor(format)}`,
    bytes,
    format,
  );
}

export const removeGreenScreen = (options: BackgroundRemovalOptions) =>
  removeColorBackground({ ...options, color: "green" });
export const removeBlueScreen = (options: BackgroundRemovalOptions) =>
  removeColorBackground({ ...options, color: "blue" });
export const removeWhiteBackground = (options: BackgroundRemovalOptions) =>
  removeColorBackground({ ...options, color: "white" });

export async function resizeImage(
  options: SingleImageOptions & { width: number; height?: number },
): Promise<MediaOutput> {
  const format = options.format ?? "png";
  assertImageFormat(format);
  assertInteger(options.width, 1, 16384, "width");
  assertDimension(options.height, "height");
  const bytes = await sharp(options.inputPath, { limitInputPixels: MAX_PIXELS })
    .autoOrient()
    .resize(options.width, options.height, {
      fit: options.height === undefined ? "inside" : "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toFormat(format)
    .toBuffer();
  return imageOutput(`resized.${extensionFor(format)}`, bytes, format);
}

export async function outlineImage(
  options: SingleImageOptions & { thickness: number; color?: string },
): Promise<MediaOutput> {
  const format = options.format ?? "png";
  assertTransparentFormat(format);
  assertInteger(options.thickness, 1, 64, "thickness");
  const source = sharp(options.inputPath, { limitInputPixels: MAX_PIXELS })
    .autoOrient()
    .toColourspace("srgb")
    .ensureAlpha();
  const { data, info } = await source
    .clone()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const radius = options.thickness;
  const width = info.width + radius * 2;
  const height = info.height + radius * 2;
  // libvips dilates dark pixels, so invert alpha before expanding the subject.
  const mask = Buffer.alloc(width * height, 255);
  for (let y = 0; y < info.height; y += 1)
    for (let x = 0; x < info.width; x += 1)
      mask[(y + radius) * width + x + radius] = 255 - data[(y * info.width + x) * 4 + 3]!;
  const expanded = await sharp(mask, {
    raw: { width, height, channels: 1 },
  })
    .dilate(radius)
    .greyscale()
    .raw()
    .toBuffer();
  const color = options.color ?? "#e5484d";
  if (!/^#[0-9a-fA-F]{6}$/.test(color))
    throw new Error("color must be a six-digit hex color");
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < mask.length; index++) {
    for (let channel = 0; channel < 3; channel++)
      rgba[index * 4 + channel] = parseInt(
        color.slice(1 + channel * 2, 3 + channel * 2),
        16,
      );
    rgba[index * 4 + 3] = 255 - expanded[index]!;
  }
  const outline = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
  const bytes = await sharp(outline)
    .composite([{ input: await source.png().toBuffer(), left: radius, top: radius }])
    .toFormat(format)
    .toBuffer();
  return imageOutput(`outlined.${extensionFor(format)}`, bytes, format);
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
  return imageOutput(`cropped.${extensionFor(format)}`, bytes, format);
}

export interface CutoutPoint {
  x: number;
  y: number;
}
export async function cutoutImage(
  options: SingleImageOptions & { points: CutoutPoint[] },
): Promise<MediaOutput> {
  if (options.points.length < 3 || options.points.length > 1000)
    throw new Error("Cutout requires 3 to 1000 polygon points");
  const format = options.format ?? "png";
  assertTransparentFormat(format);
  const { data, info } = await sharp(options.inputPath, {
    limitInputPixels: MAX_PIXELS,
  })
    .autoOrient()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (const point of options.points) {
    assertInteger(point.x, 0, info.width - 1, "point.x");
    assertInteger(point.y, 0, info.height - 1, "point.y");
  }
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      let inside = false;
      for (
        let i = 0, j = options.points.length - 1;
        i < options.points.length;
        j = i++
      ) {
        const a = options.points[i]!,
          b = options.points[j]!;
        if (
          a.y > y !== b.y > y &&
          x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
        )
          inside = !inside;
      }
      if (!inside) data[(y * info.width + x) * 4 + 3] = 0;
    }
  const bytes = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .toFormat(format)
    .toBuffer();
  return imageOutput(`cutout.${extensionFor(format)}`, bytes, format);
}

export async function brushRetouchImage(
  options: SingleImageOptions & {
    strokes: CutoutPoint[][];
    radius: number;
    strength?: number;
  },
): Promise<MediaOutput> {
  const format = options.format ?? "png";
  assertImageFormat(format);
  const strength = options.strength ?? 40;
  assertInteger(strength, 1, 100, "strength");
  assertInteger(options.radius, 1, 256, "radius");
  const { data, info } = await sharp(options.inputPath, {
    limitInputPixels: MAX_PIXELS,
  })
    .autoOrient()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!options.strokes.length || options.strokes.length > 1000)
    throw new Error("Draw between 1 and 1000 brush strokes");
  let count = 0;
  const paths = options.strokes.map((points) => {
    if (!points.length) throw new Error("Brush strokes must not be empty");
    count += points.length;
    if (count > 10000) throw new Error("Brush strokes exceed 10000 points");
    for (const point of points) {
      assertInteger(point.x, 0, info.width - 1, "point.x");
      assertInteger(point.y, 0, info.height - 1, "point.y");
    }
    const first = points[0]!;
    return points.length === 1
      ? `<circle cx="${first.x}" cy="${first.y}" r="${options.radius}" fill="white"/>`
      : `<polyline points="${points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="white" stroke-width="${options.radius * 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  const mask = await sharp(
    Buffer.from(
      `<svg width="${info.width}" height="${info.height}" xmlns="http://www.w3.org/2000/svg">${paths.join("")}</svg>`,
    ),
  )
    .ensureAlpha()
    .raw()
    .toBuffer();
  const blurred = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .blur(Math.max(0.3, strength / 5))
    .raw()
    .toBuffer();
  for (let index = 0; index < data.length; index += 4) {
    const alpha = mask[index + 3]! / 255;
    for (let channel = 0; channel < 3; channel++)
      data[index + channel] = Math.round(
        data[index + channel]! * (1 - alpha) +
          blurred[index + channel]! * alpha,
      );
  }
  const bytes = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .toFormat(format)
    .toBuffer();
  return imageOutput(`retouched.${extensionFor(format)}`, bytes, format);
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
  const outputs: MediaOutput[] = [];
  for (let page = 0; page < count; page++) {
    const bytes = await sharp(options.inputPath, {
      page,
      pages: 1,
      limitInputPixels: MAX_PIXELS,
    })
      .png()
      .toBuffer();
    outputs.push(
      imageOutput(`frame-${String(page).padStart(4, "0")}.png`, bytes, "png"),
    );
  }
  return outputs;
}

export const composeGif = (
  framePaths: string[],
  fps = 12,
  signal?: AbortSignal,
) => composeVideo({ framePaths, fps, format: "gif", signal });

export async function sortFrames(framePaths: string[]): Promise<MediaOutput[]> {
  if (!framePaths.length || framePaths.length > MAX_FRAMES)
    throw new Error("Choose between 1 and 1000 frames");
  return Promise.all(
    framePaths.map(async (inputPath, index) => {
      const bytes = await sharp(inputPath, { limitInputPixels: MAX_PIXELS })
        .autoOrient()
        .png()
        .toBuffer();
      return imageOutput(
        `frame-${String(index).padStart(4, "0")}.png`,
        bytes,
        "png",
      );
    }),
  );
}

export async function stitchImages(options: {
  inputPaths: string[];
  direction?: "horizontal" | "vertical";
}): Promise<MediaOutput> {
  if (!options.inputPaths.length || options.inputPaths.length > MAX_FRAMES)
    throw new Error("Choose between 1 and 1000 images");
  const direction = options.direction ?? "horizontal";
  if (direction !== "horizontal" && direction !== "vertical")
    throw new Error("Invalid stitch direction");
  const images = await Promise.all(
    options.inputPaths.map(async (input) => {
      const image = sharp(input, { limitInputPixels: MAX_PIXELS })
        .autoOrient()
        .ensureAlpha();
      const metadata = await image.metadata();
      const { width, height } = metadata.autoOrient ?? metadata;
      if (!width || !height) throw new Error("Could not read image dimensions");
      return { input: await image.png().toBuffer(), width, height };
    }),
  );
  const width =
    direction === "horizontal"
      ? images.reduce((sum, image) => sum + image.width, 0)
      : Math.max(...images.map((image) => image.width));
  const height =
    direction === "vertical"
      ? images.reduce((sum, image) => sum + image.height, 0)
      : Math.max(...images.map((image) => image.height));
  if (width * height > MAX_PIXELS)
    throw new Error(
      `Stitched image exceeds the ${MAX_PIXELS.toLocaleString()} pixel limit`,
    );
  let offset = 0;
  const layers = images.map((image) => {
    const layer = {
      input: image.input,
      left: direction === "horizontal" ? offset : 0,
      top: direction === "vertical" ? offset : 0,
    };
    offset += direction === "horizontal" ? image.width : image.height;
    return layer;
  });
  return imageOutput(
    "stitched.png",
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(layers)
      .png()
      .toBuffer(),
    "png",
  );
}

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
  const layers = await Promise.all(options.inputPaths.map(async (inputPath, index) => {
    const layer = options.layers[index]!;
    assertInteger(layer.x, -16_384, 16_384, "layer.x");
    assertInteger(layer.y, -16_384, 16_384, "layer.y");
    assertRange(layer.scale, 0.05, 8, "layer.scale");
    assertRange(layer.opacity, 0, 1, "layer.opacity");
    if (typeof layer.visible !== "boolean") throw new Error("layer.visible must be a boolean");
    if (!layer.visible || layer.opacity === 0) return undefined;
    const source = sharp(inputPath, { animated: false, limitInputPixels: MAX_PIXELS }).autoOrient();
    const metadata = await source.metadata();
    const dimensions = metadata.autoOrient ?? metadata;
    if (!dimensions.width || !dimensions.height) throw new Error("Could not read layer dimensions");
    const width = Math.max(1, Math.round(dimensions.width * layer.scale));
    const height = Math.max(1, Math.round(dimensions.height * layer.scale));
    assertDimension(width, "layer width");
    assertDimension(height, "layer height");
    if (width * height > MAX_PIXELS) throw new Error("Scaled layer is too large");
    const left = Math.max(0, layer.x);
    const top = Math.max(0, layer.y);
    const cropWidth = Math.min(width - (left - layer.x), options.width - left);
    const cropHeight = Math.min(height - (top - layer.y), options.height - top);
    if (cropWidth <= 0 || cropHeight <= 0) return undefined;
    const { data, info } = await source.resize(width, height, { fit: "fill" })
      .extract({ left: left - layer.x, top: top - layer.y, width: cropWidth, height: cropHeight })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (layer.opacity < 1) for (let offset = 3; offset < data.length; offset += info.channels)
      data[offset] = Math.round(data[offset]! * layer.opacity);
    return { input: await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer(), left, top };
  }));
  return imageOutput("composed-layers.png", await sharp({
    create: { width: options.width, height: options.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(layers.filter((layer): layer is NonNullable<typeof layer> => Boolean(layer))).png().toBuffer(), "png");
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
      outputs.push({
        name: `frame-${String(index).padStart(4, "0")}.${extensionFor(format)}`,
        bytes,
        mediaType: mediaTypeFor(format),
      });
    }
  }
  if (options.includeManifest !== false) {
    outputs.push({
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
export async function extractVideoFrames(
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
    await runFfmpeg(args, options.signal);
    const files = (await readdir(temporary))
      .filter((file) => file.endsWith(`.${extension}`))
      .sort();
    if (!files.length) throw new Error("FFmpeg produced no frames");
    const selectedSet = selected ? new Set(selected) : undefined;
    const indices = files.map((_, index) => index).filter((index) => !selectedSet || selectedSet.has(index));
    if (!indices.length) throw new Error("No selected frames exist in this video range");
    const outputs = await Promise.all(
      indices.map(async (index) => ({
        name: `frame-${String(index).padStart(4, "0")}.${extension}`,
        bytes: await readFile(path.join(temporary, files[index]!)),
        mediaType: extension === "jpg" ? "image/jpeg" : "image/png",
      })),
    );
    if (options.includeManifest !== false) {
      const fps = options.fps ?? 12;
      outputs.push({
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

/** Alias for the frame-strip operation exposed to agents as a separate tool. */
export async function extractVideoStrip(
  options: ExtractFramesOptions,
): Promise<MediaOutput[]> {
  return extractVideoFrames(options);
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
    const firstImage = sharp(options.framePaths[0]!, {
      animated: false,
      limitInputPixels: MAX_PIXELS,
    }).autoOrient();
    const firstMetadata = await firstImage.metadata();
    const firstDimensions = firstMetadata.autoOrient ?? firstMetadata;
    if (!firstDimensions.width || !firstDimensions.height)
      throw new Error("Could not read the first frame dimensions");
    const width =
      format === "mp4"
        ? firstDimensions.width + (firstDimensions.width % 2)
        : firstDimensions.width;
    const height =
      format === "mp4"
        ? firstDimensions.height + (firstDimensions.height % 2)
        : firstDimensions.height;
    await Promise.all(
      options.framePaths.map(async (source, index) => {
        const image = sharp(source, {
          animated: false,
          limitInputPixels: MAX_PIXELS,
        }).autoOrient();
        await image
          .resize({
            width,
            height,
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            withoutEnlargement: false,
          })
          .png()
          .toFile(
            path.join(temporary, `frame-${String(index + 1).padStart(6, "0")}.png`),
          );
      }),
    );
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
    await runFfmpeg(args, options.signal);
    return {
      name: `composed.${format}`,
      bytes: await readFile(output),
      mediaType: format === "gif" ? "image/gif" : "video/mp4",
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function zipMediaOutputs(
  outputs: readonly MediaOutput[],
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const output of outputs) zip.addBuffer(output.bytes, output.name);
  const chunks: Buffer[] = [];
  const stream = zip.outputStream as AsyncIterable<Buffer>;
  const done = (async () => {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  })();
  zip.end();
  await done;
  return Buffer.concat(chunks);
}

function gridEdges(size: number, cells: number): number[] {
  return Array.from({ length: cells + 1 }, (_, index) =>
    Math.round((index * size) / cells),
  );
}

function assertTransparentFormat(format: string): void {
  if (format !== "png" && format !== "webp") throw new Error("This operation requires PNG or WebP to preserve transparency");
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



async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Operation cancelled");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`FFmpeg is unavailable: ${error.message}`));
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Operation cancelled"));
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
