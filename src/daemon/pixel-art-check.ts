import sharp from "sharp";
import {
  parseHexColor,
  type PixelArtCheckBatch,
  type PixelArtCheckExpectations,
  type PixelArtCheckItem,
  type PixelArtCheckReport,
} from "../shared/pixel-art-check.js";

/**
 * Measures pixel art against rules that can be counted: logical size after a
 * uniform nearest-neighbour enlargement, semi-transparent pixels, colours,
 * lone pixels, outline coverage, feet row, and horizontal centre. Settings in
 * the request (size, colours, feet row, outline colour) turn the matching
 * measurements into pass/fail rules.
 */

const MAX_INPUT_PIXELS = 4_000_000;
const ALPHA_THRESHOLD = 128;
/**
 * Highest share of lone pixels among opaque pixels that still passes the
 * check. Hand-corrected 96×96 character sprites measure 5–12%: eye
 * highlights, ribbon tips, and shading accents are single pixels on purpose.
 */
const ISOLATED_LIMIT = 0.12;
/** Share of the outermost ring that must use the requested outline colour. */
const OUTLINE_LIMIT = 0.8;

export class PixelArtCheckError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 422,
  ) {
    super(message);
  }
}

interface Decoded { data: Buffer; width: number; height: number }

async function decode(bytes: Buffer): Promise<Decoded> {
  const { data, info } = await sharp(bytes, {
    animated: false,
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .autoOrient()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width * info.height > MAX_INPUT_PIXELS)
    throw new PixelArtCheckError("Pixel art check supports images up to 4 megapixels", 413);
  return { data, width: info.width, height: info.height };
}

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

function opaqueBounds(
  data: Buffer,
  width: number,
  height: number,
): { left: number; top: number; right: number; bottom: number } | undefined {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!data[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  return right > left ? { left, top, right, bottom } : undefined;
}

function sameColour(data: Buffer, first: number, second: number): boolean {
  return data[first + 3] !== 0 && data[second + 3] !== 0 &&
    data[first] === data[second] && data[first + 1] === data[second + 1] && data[first + 2] === data[second + 2];
}

function isEdge(data: Buffer, width: number, height: number, x: number, y: number): boolean {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height || !data[(ny * width + nx) * 4 + 3]) return true;
  }
  return false;
}

interface PixelArtAnalysis {
  report: PixelArtCheckReport;
  bottom?: number;
  colours: Set<number>;
}

/** Measures one image against the pixel-art rules and any expected settings. */
export async function checkPixelArt(
  bytes: Buffer,
  expected: PixelArtCheckExpectations = {},
): Promise<PixelArtCheckReport> {
  return (await checkPixelArtImages([bytes], expected)).reports[0]!;
}

/** Checks images that belong together, such as views or frames of one subject. */
export async function checkPixelArtImages(
  images: readonly Buffer[],
  expected: PixelArtCheckExpectations = {},
): Promise<PixelArtCheckBatch> {
  const decoded: Decoded[] = [];
  for (const bytes of images) decoded.push(await decode(bytes));
  // A plain shape enlarged 2× is also a valid 4× enlargement, so images that
  // belong together are measured at one shared scale.
  const scale = decoded
    .map((image) => nativeScale(image, expected))
    .reduce((shared, next) => greatestCommonDivisor(shared, next));
  const analyses = decoded.map((image) => analysePixelArt(image, scale, expected));
  const reports = analyses.map((analysis) => analysis.report);
  if (analyses.length < 2) return { reports };
  const colours = new Set<number>();
  for (const analysis of analyses) for (const colour of analysis.colours) colours.add(colour);
  return {
    reports,
    shared: {
      sameSize: reports.every((report) => report.width === reports[0]!.width && report.height === reports[0]!.height),
      sameBaseline: analyses.every((analysis) => analysis.bottom === analyses[0]!.bottom),
      colors: colours.size,
    },
  };
}

function analysePixelArt(
  decoded: Decoded,
  scale: number,
  expected: PixelArtCheckExpectations,
): PixelArtAnalysis {
  let semiTransparent = 0;
  for (let at = 3; at < decoded.data.length; at += 4)
    if (decoded.data[at]! > 0 && decoded.data[at]! < 255) semiTransparent++;
  const width = decoded.width / scale;
  const height = decoded.height / scale;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      decoded.data.copy(data, (y * width + x) * 4, (y * scale * decoded.width + x * scale) * 4, (y * scale * decoded.width + x * scale) * 4 + 4);
  const logical = thresholdAlpha(data);

  const colours = new Set<number>();
  let opaque = 0;
  let isolated = 0;
  let edges = 0;
  let outlined = 0;
  const outline = expected.outline ? parseHexColor(expected.outline) : undefined;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (!logical[at + 3]) continue;
      opaque++;
      colours.add((logical[at]! << 16) | (logical[at + 1]! << 8) | logical[at + 2]!);
      let alone = true;
      for (let dy = -1; dy <= 1 && alone; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
          if (sameColour(logical, at, ((y + dy) * width + x + dx) * 4)) {
            alone = false;
            break;
          }
        }
      if (alone) isolated++;
      if (!isEdge(logical, width, height, x, y)) continue;
      edges++;
      if (outline
        ? logical[at] === outline[0] && logical[at + 1] === outline[1] && logical[at + 2] === outline[2]
        : logical[at]! + logical[at + 1]! + logical[at + 2]! < 150) outlined++;
    }
  const bounds = opaqueBounds(logical, width, height);
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const items: PixelArtCheckItem[] = [
    {
      id: "size",
      status: expected.width && expected.height ? (width === expected.width && height === expected.height ? "pass" : "fail") : "info",
      value: `${width}×${height}`,
      ...(expected.width && expected.height ? { expected: `${expected.width}×${expected.height}` } : {}),
    },
    { id: "alpha", status: semiTransparent ? "fail" : "pass", value: String(semiTransparent), expected: "0" },
    {
      id: "colors",
      status: expected.colors ? (colours.size <= expected.colors ? "pass" : "fail") : "info",
      value: String(colours.size),
      ...(expected.colors ? { expected: `≤ ${expected.colors}` } : {}),
    },
    {
      id: "isolated",
      status: isolated <= opaque * ISOLATED_LIMIT ? "pass" : "fail",
      value: `${isolated} (${percent(isolated / Math.max(opaque, 1))})`,
      expected: `≤ ${percent(ISOLATED_LIMIT)}`,
    },
    {
      id: "outline",
      status: outline ? (outlined >= edges * OUTLINE_LIMIT ? "pass" : "fail") : "info",
      value: percent(outlined / Math.max(edges, 1)),
      ...(outline ? { expected: `≥ ${percent(OUTLINE_LIMIT)}` } : {}),
    },
    {
      id: "baseline",
      status: expected.baseline === undefined || !bounds ? "info" : bounds.bottom - 1 === expected.baseline ? "pass" : "fail",
      value: bounds ? String(bounds.bottom - 1) : "—",
      ...(expected.baseline === undefined ? {} : { expected: String(expected.baseline) }),
    },
    {
      id: "center",
      status: "info",
      value: bounds ? String((bounds.left + bounds.right - 1) / 2) : "—",
      expected: String((width - 1) / 2),
    },
  ];
  return {
    report: { width, height, scale, passed: items.every((item) => item.status !== "fail"), items },
    bottom: bounds ? bounds.bottom - 1 : undefined,
    colours,
  };
}

/**
 * The enlargement that produced an image: the one implied by the expected
 * size when the image matches it, otherwise the largest uniform one.
 */
function nativeScale({ data, width, height }: Decoded, expected: PixelArtCheckExpectations): number {
  if (expected.width && expected.height && width % expected.width === 0 && width / expected.width === height / expected.height) {
    const scale = width / expected.width;
    if (scale === 1 || isEnlargedBy(data, width, height, scale)) return scale;
  }
  const divisor = greatestCommonDivisor(width, height);
  for (let scale = divisor; scale > 1; scale--) {
    if (divisor % scale) continue;
    if (isEnlargedBy(data, width, height, scale)) return scale;
  }
  return 1;
}

function isEnlargedBy(data: Buffer, width: number, height: number, scale: number): boolean {
  for (let y = 0; y < height; y++) {
    const rowStart = (y - (y % scale)) * width;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const origin = (rowStart + x - (x % scale)) * 4;
      if (data[at + 3] !== data[origin + 3]) return false;
      if (data[at + 3] && (data[at] !== data[origin] || data[at + 1] !== data[origin + 1] || data[at + 2] !== data[origin + 2])) return false;
    }
  }
  return true;
}

function greatestCommonDivisor(first: number, second: number): number {
  while (second) [first, second] = [second, first % second];
  return first;
}
