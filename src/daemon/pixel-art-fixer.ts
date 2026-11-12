import sharp from "sharp";
import { perfectPixel } from "./perfect-pixel.js";

/**
 * Turns generated pixel-style art into a clean, grid-aligned PNG with the
 * perfect-pixel method: the image's own (often uneven) pixel grid is found
 * and each cell becomes one pixel. Like the perfect-pixel web demo, very
 * small images are enlarged and large ones reduced to 1024 pixels before the
 * grid is measured. Alpha becomes fully transparent or opaque, colours that
 * differ only by noise are merged, and the result is enlarged with
 * nearest-neighbour scaling back to about the source size.
 */

const MAX_INPUT_PIXELS = 4_000_000;
const WORKING_MAX_SIDE = 1024;
const SMALL_SIDE = 64;
const SMALL_TARGET = 256;
const ALPHA_THRESHOLD = 128;
/**
 * Colours closer than this (RGB distance) are one colour drawn with noise or
 * compression error. Generated images give hundreds or thousands of such
 * near-identical colours, which look flat but are not. At 24 a generated
 * character keeps its hair shading, eye colours, and highlights; at 32 hair
 * and eye tones begin to merge.
 */
const MERGE_DISTANCE = 24;

export class PixelArtFixerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 422,
  ) {
    super(message);
  }
}

export interface PixelArtFixResult {
  bytes: Buffer;
  mediaType: "image/png";
  width: number;
  height: number;
}

export async function fixPixelArt(bytes: Buffer): Promise<PixelArtFixResult> {
  const source = await sharp(bytes, {
    animated: false,
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .autoOrient()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (source.info.width * source.info.height > MAX_INPUT_PIXELS)
    throw new PixelArtFixerError(
      "Pixel art fixer supports images up to 4 megapixels",
      413,
    );

  const working = await workingImage(source.data, source.info.width, source.info.height);
  const result = perfectPixel(working);
  if (!result)
    throw new PixelArtFixerError(
      "No pixel grid was found in this image. Fix pixel art works on images drawn as pixel art.",
    );
  thresholdAlpha(result.data);
  mergeNearColours(result.data);
  const scale = Math.max(1, Math.round(source.info.width / result.width));
  const png = await sharp(result.data, {
    raw: { width: result.width, height: result.height, channels: 4 },
  })
    .resize({
      width: result.width * scale,
      height: result.height * scale,
      kernel: "nearest",
      fit: "fill",
    })
    .png()
    .toBuffer();
  return {
    bytes: png,
    mediaType: "image/png",
    width: result.width * scale,
    height: result.height * scale,
  };
}

/**
 * The image at the size the grid is measured on: small images are enlarged by
 * a whole number, large ones reduced so their longest side is 1024 pixels.
 * Reduction samples the four nearest pixels, as a browser canvas does in the
 * perfect-pixel web demo; the detected grid is sensitive to this filtering.
 * Fully transparent pixels become black, as a canvas stores them.
 */
async function workingImage(
  data: Buffer,
  width: number,
  height: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  let image: { data: Buffer; width: number; height: number } = { data: Buffer.from(data), width, height };
  if (Math.min(width, height) < SMALL_SIDE) {
    const factor = Math.ceil((SMALL_TARGET + 1) / Math.min(width, height));
    image = {
      data: await sharp(data, { raw: { width, height, channels: 4 } })
        .resize({ width: width * factor, height: height * factor, fit: "fill", kernel: "nearest" })
        .raw()
        .toBuffer(),
      width: width * factor,
      height: height * factor,
    };
  }
  if (Math.max(image.width, image.height) > WORKING_MAX_SIDE) {
    const factor = WORKING_MAX_SIDE / Math.max(image.width, image.height);
    image = bilinear(image, Math.round(image.width * factor), Math.round(image.height * factor));
  }
  for (let at = 0; at < image.data.length; at += 4)
    if (image.data[at + 3] === 0) image.data[at] = image.data[at + 1] = image.data[at + 2] = 0;
  return image;
}

function bilinear(
  source: { data: Buffer; width: number; height: number },
  width: number,
  height: number,
): { data: Buffer; width: number; height: number } {
  const data = Buffer.alloc(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const top = Math.floor(sourceY);
    const bottom = Math.min(source.height - 1, top + 1);
    const weightY = sourceY - top;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(source.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const left = Math.floor(sourceX);
      const right = Math.min(source.width - 1, left + 1);
      const weightX = sourceX - left;
      for (let channel = 0; channel < 4; channel++) {
        const at = (column: number, row: number) => source.data[(row * source.width + column) * 4 + channel]!;
        data[(y * width + x) * 4 + channel] = Math.round(
          at(left, top) * (1 - weightX) * (1 - weightY) +
          at(right, top) * weightX * (1 - weightY) +
          at(left, bottom) * (1 - weightX) * weightY +
          at(right, bottom) * weightX * weightY,
        );
      }
    }
  }
  return { data, width, height };
}

/**
 * Merge near-identical colours. Colours are visited from most to least common;
 * each joins the first kept colour within MERGE_DISTANCE, or is kept itself. A
 * region therefore takes its most common real colour, and distinct colours
 * such as highlights stay.
 */
function mergeNearColours(data: Uint8Array): void {
  const counts = new Map<number, number>();
  for (let at = 0; at < data.length; at += 4) {
    if (!data[at + 3]) continue;
    const key = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const kept: number[] = [];
  const target = new Map<number, number>();
  for (const [key] of [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const match = kept.find((candidate) =>
      ((candidate >> 16) - (key >> 16)) ** 2 +
      (((candidate >> 8) & 0xff) - ((key >> 8) & 0xff)) ** 2 +
      ((candidate & 0xff) - (key & 0xff)) ** 2 <= MERGE_DISTANCE ** 2);
    if (match === undefined) kept.push(key);
    target.set(key, match ?? key);
  }
  for (let at = 0; at < data.length; at += 4) {
    if (!data[at + 3]) continue;
    const colour = target.get((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!)!;
    data[at] = colour >> 16;
    data[at + 1] = (colour >> 8) & 0xff;
    data[at + 2] = colour & 0xff;
  }
}

/** Remove semi-transparent edge colours. */
function thresholdAlpha(data: Uint8Array): void {
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3]! < ALPHA_THRESHOLD) {
      data[at] = 0;
      data[at + 1] = 0;
      data[at + 2] = 0;
      data[at + 3] = 0;
    } else data[at + 3] = 255;
  }
}
