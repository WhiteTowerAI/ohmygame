import sharp from "sharp";

/**
 * Turns an image into a clean, grid-aligned pixel-art PNG. A detected grid
 * supplies the native pixel size; images without a measurable grid use a
 * predictable 128px working size instead. Both paths run the same complete
 * repair pipeline: binary alpha, downsample, palette reduction, and integral
 * nearest-neighbour enlargement.
 */

const MAX_INPUT_PIXELS = 4_000_000;
const WORKING_MAX_SIDE = 128;
const MAX_PALETTE_COLOURS = 48;
const ALPHA_THRESHOLD = 128;

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

interface PixelDimensions {
  width: number;
  height: number;
  scale: number;
}

export async function fixPixelArt(bytes: Buffer): Promise<PixelArtFixResult> {
  const image = sharp(bytes, {
    animated: false,
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .autoOrient()
    .ensureAlpha();
  const { data, info } = await image
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width * info.height > MAX_INPUT_PIXELS)
    throw new PixelArtFixerError(
      "Pixel art fixer supports images up to 4 megapixels",
      413,
    );

  const source = thresholdAlpha(data);
  const dimensions = await inferPixelDimensions(source, info.width, info.height);
  const low = await sharp(source, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: "fill",
      kernel: "lanczos3",
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const indexed = reducePalette(thresholdAlpha(low));
  const width = dimensions.width * dimensions.scale;
  const height = dimensions.height * dimensions.scale;
  const png = await sharp(indexed, {
    raw: { width: dimensions.width, height: dimensions.height, channels: 4 },
  })
    .resize({ width, height, kernel: "nearest", fit: "fill" })
    .png()
    .toBuffer();
  return { bytes: png, mediaType: "image/png", width, height };
}

/** Remove semi-transparent edge colours before sampling the source image. */
function thresholdAlpha(data: Buffer): Buffer {
  const result = Buffer.from(data);
  for (let at = 0; at < result.length; at += 4) {
    if (result[at + 3]! < ALPHA_THRESHOLD) {
      result[at] = 0;
      result[at + 1] = 0;
      result[at + 2] = 0;
      result[at + 3] = 0;
    } else result[at + 3] = 255;
  }
  return result;
}

async function inferPixelDimensions(
  data: Buffer,
  width: number,
  height: number,
): Promise<PixelDimensions> {
  const probeScale = Math.min(1, 256 / Math.max(width, height));
  const probe = await sharp(data, {
    raw: { width, height, channels: 4 },
  })
    .resize({
      width: Math.max(1, Math.round(width * probeScale)),
      height: Math.max(1, Math.round(height * probeScale)),
      fit: "fill",
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const detectedCell = legacyCellSize(
    probe.data,
    probe.info.width,
    probe.info.height,
  );
  const scale = detectedCell
    ? Math.max(1, Math.round(detectedCell / probeScale))
    : Math.max(1, Math.round(Math.max(width, height) / WORKING_MAX_SIDE));
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
    scale,
  };
}

/**
 * The light-weight, phase-zero grid signal used by the earlier implementation.
 * It is only an input-size hint; failure never skips the pixel-art pipeline.
 */
function legacyCellSize(
  data: Buffer,
  width: number,
  height: number,
): number | undefined {
  let best: { step: number; score: number } | undefined;
  for (
    let step = 2;
    step <= Math.min(24, Math.floor(Math.min(width, height) / 3));
    step++
  ) {
    let edge = 0;
    let inside = 0;
    let edgeCount = 0;
    let insideCount = 0;
    for (let y = 0; y < height; y++)
      for (let x = 1; x < width; x++) {
        const delta = colourDistance(
          data,
          (y * width + x - 1) * 4,
          (y * width + x) * 4,
        );
        if (x % step === 0) {
          edge += delta;
          edgeCount++;
        } else {
          inside += delta;
          insideCount++;
        }
      }
    for (let y = 1; y < height; y++)
      for (let x = 0; x < width; x++) {
        const delta = colourDistance(
          data,
          ((y - 1) * width + x) * 4,
          (y * width + x) * 4,
        );
        if (y % step === 0) {
          edge += delta;
          edgeCount++;
        } else {
          inside += delta;
          insideCount++;
        }
      }
    const candidate = {
      step,
      score: edge / Math.max(edgeCount, 1) - inside / Math.max(insideCount, 1),
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best && best.score > 10 ? best.step : undefined;
}

function colourDistance(data: Buffer, first: number, second: number): number {
  const alphaA = data[first + 3]! / 255;
  const alphaB = data[second + 3]! / 255;
  return (
    Math.abs(data[first]! * alphaA - data[second]! * alphaB) +
    Math.abs(data[first + 1]! * alphaA - data[second + 1]! * alphaB) +
    Math.abs(data[first + 2]! * alphaA - data[second + 2]! * alphaB) +
    Math.abs(data[first + 3]! - data[second + 3]!)
  );
}

/**
 * Build a palette from colours actually present in the image, then map each
 * opaque pixel to its nearest palette colour. It cannot create the stray
 * purple/pink hues caused by independently quantising RGB channels.
 */
function reducePalette(data: Buffer): Buffer {
  const bins = new Map<number, [number, number, number, number]>();
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3] === 0) continue;
    const key =
      ((data[at]! >> 3) << 10) |
      ((data[at + 1]! >> 3) << 5) |
      (data[at + 2]! >> 3);
    const bin = bins.get(key) ?? [0, 0, 0, 0];
    bin[0]++;
    bin[1] += data[at]!;
    bin[2] += data[at + 1]!;
    bin[3] += data[at + 2]!;
    bins.set(key, bin);
  }
  const candidates = [...bins.values()]
    .sort((left, right) => right[0] - left[0])
    .map(([count, red, green, blue]) => ({
      count,
      colour: [
      Math.round(red / count),
      Math.round(green / count),
      Math.round(blue / count),
      ] as const,
    }));
  // Keep the common colours, then fill the remaining slots with colours that
  // are far from the chosen palette. A pure frequency ranking discarded rare
  // navy and gold accents in illustrations in favour of nearly identical skin
  // and background shades, which produced an obvious hue shift.
  const palette = candidates
    .slice(0, Math.min(24, MAX_PALETTE_COLOURS))
    .map((candidate) => candidate.colour);
  while (palette.length < MAX_PALETTE_COLOURS && palette.length < candidates.length) {
    let selected: typeof candidates[number] | undefined;
    let bestScore = -1;
    for (const candidate of candidates) {
      if (palette.some((colour) => colour === candidate.colour)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const colour of palette) {
        const distance =
          (candidate.colour[0] - colour[0]) ** 2 +
          (candidate.colour[1] - colour[1]) ** 2 +
          (candidate.colour[2] - colour[2]) ** 2;
        nearest = Math.min(nearest, distance);
      }
      // Frequency keeps isolated compression noise out; distance reserves
      // palette slots for visually distinct accent colours.
      const score = nearest * (1 + Math.log2(candidate.count + 1));
      if (score > bestScore) {
        selected = candidate;
        bestScore = score;
      }
    }
    if (!selected) break;
    palette.push(selected.colour);
  }
  const result = Buffer.from(data);
  if (!palette.length) return result;
  for (let at = 0; at < result.length; at += 4) {
    if (result[at + 3] === 0) continue;
    let nearest = palette[0]!;
    let distance = Number.POSITIVE_INFINITY;
    for (const colour of palette) {
      const next =
        (result[at]! - colour[0]) ** 2 +
        (result[at + 1]! - colour[1]) ** 2 +
        (result[at + 2]! - colour[2]) ** 2;
      if (next < distance) {
        nearest = colour;
        distance = next;
      }
    }
    result[at] = nearest[0];
    result[at + 1] = nearest[1];
    result[at + 2] = nearest[2];
  }
  return result;
}
