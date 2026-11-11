/*
 * Pixel-grid detection and sampling ported from perfect-pixel 0.1.4
 * (src/perfect_pixel/perfect_pixel_noCV2.py), https://github.com/theamusing/perfectPixel
 *
 * MIT License
 *
 * Copyright (c) theAmusing
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The image is estimated to be a grid of logical pixels: the cell size comes
 * from the frequency spectrum (or, failing that, from the spacing of edges),
 * then every grid line is moved to the strongest nearby edge, so cells of
 * uneven width in generated images still line up. Each cell takes the colour
 * at its centre.
 *
 * Settings follow the perfect-pixel web demo (perfectPixel_webdemo), whose
 * results users compare against, rather than the Python defaults: the spectrum
 * is taken on a power-of-two canvas of at most 1024 pixels, peaks are searched
 * between 15% and 185% of the centre, and grid lines move up to a third of a
 * cell. Unlike the demo, an image without a measurable grid is reported rather
 * than given an 8-pixel grid.
 */

export interface RgbaImage {
  data: Uint8Array | Buffer;
  width: number;
  height: number;
}

export interface PerfectPixelResult extends RgbaImage {
  /** Average source pixels per logical pixel, horizontally and vertically. */
  cellWidth: number;
  cellHeight: number;
}

const MIN_SIZE = 4;
const MAX_PIXEL_SIZE = 20;
const MAX_RATIO = 1.5;
const PEAK_WIDTH = 6;
const REFINE_INTENSITY = 1 / 3;
const FFT_MAX_SIDE = 1024;

/** Returns undefined when no pixel grid can be found. */
export function perfectPixel(image: RgbaImage): PerfectPixelResult | undefined {
  const { width, height } = image;
  const gray = rgbToGray(image);
  const scale = detectGridScale(gray, width, height);
  if (!scale) return undefined;
  const { gradX, gradY } = gradientSums(gray, width, height);
  const xCoords = refineGrid(width, scale.gridWidth, gradX);
  const yCoords = refineGrid(height, scale.gridHeight, gradY);
  let result = sampleCenter(image, xCoords, yCoords);
  result = fixSquare(result);
  return {
    ...result,
    cellWidth: width / result.width,
    cellHeight: height / result.height,
  };
}

function rgbToGray({ data, width, height }: RgbaImage): Float32Array {
  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index++)
    gray[index] = 0.299 * data[index * 4]! + 0.587 * data[index * 4 + 1]! + 0.114 * data[index * 4 + 2]!;
  return gray;
}

function normalizeMinMax(values: Float64Array): Float64Array {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const result = new Float64Array(values.length);
  if (max - min < 1e-8) return result;
  for (let index = 0; index < values.length; index++) result[index] = (values[index]! - min) / (max - min);
  return result;
}

/** numpy `pad(..., mode="reflect")` index for one axis. */
function reflect(index: number, size: number): number {
  if (size === 1) return 0;
  while (index < 0 || index >= size) index = index < 0 ? -index : 2 * (size - 1) - index;
  return index;
}

/**
 * Column sums of |Sobel x| and row sums of |Sobel y| over the grey image,
 * using the library's correlation with reflected borders.
 */
function gradientSums(gray: Float32Array, width: number, height: number): { gradX: Float64Array; gradY: Float64Array } {
  const gradX = new Float64Array(width);
  const gradY = new Float64Array(height);
  const at = (x: number, y: number) => gray[reflect(y, height) * width + reflect(x, width)]!;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      gradX[x] += Math.abs(gx);
      gradY[y] += Math.abs(gy);
    }
  return { gradX, gradY };
}

function detectGridScale(gray: Float32Array, width: number, height: number): { gridWidth: number; gridHeight: number } | undefined {
  let grid = estimateGridFft(gray, width, height);
  if (grid) {
    const pixelX = width / grid.gridWidth;
    const pixelY = height / grid.gridHeight;
    if (Math.min(pixelX, pixelY) < MIN_SIZE || Math.max(pixelX, pixelY) > MAX_PIXEL_SIZE || pixelX / pixelY > MAX_RATIO || pixelY / pixelX > MAX_RATIO)
      grid = estimateGridGradient(gray, width, height);
  } else grid = estimateGridGradient(gray, width, height);
  if (!grid) return undefined;
  const pixelX = width / grid.gridWidth;
  const pixelY = height / grid.gridHeight;
  const pixelSize = pixelX / pixelY > MAX_RATIO || pixelY / pixelX > MAX_RATIO
    ? Math.min(pixelX, pixelY)
    : (pixelX + pixelY) / 2;
  return { gridWidth: Math.round(width / pixelSize), gridHeight: Math.round(height / pixelSize) };
}

function estimateGridFft(source: Float32Array, sourceWidth: number, sourceHeight: number): { gridWidth: number; gridHeight: number } | undefined {
  // Zero-padded (or cropped) to a power of two; frequencies are rescaled to the image afterwards.
  const powerOfTwo = (size: number) => Math.min(2 ** Math.ceil(Math.log2(size)), FFT_MAX_SIDE);
  const width = powerOfTwo(sourceWidth);
  const height = powerOfTwo(sourceHeight);
  const gray = new Float32Array(width * height);
  for (let y = 0; y < Math.min(sourceHeight, height); y++)
    gray.set(source.subarray(y * sourceWidth, y * sourceWidth + Math.min(sourceWidth, width)), y * width);
  const magnitude = fftMagnitude(gray, width, height);
  // 1 - log1p(|F|), normalised over the whole (shifted) spectrum.
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < magnitude.length; index++) {
    magnitude[index] = 1 - Math.log1p(magnitude[index]!);
    min = Math.min(min, magnitude[index]!);
    max = Math.max(max, magnitude[index]!);
  }
  const range = max - min < 1e-8 ? 0 : max - min;
  const columns = 2 * Math.floor(width / 2);
  const rows = 2 * Math.floor(height / 2);
  const rowSum = new Float64Array(height);
  const columnSum = new Float64Array(width);
  // fftshift moves frequency k to index (k + floor(n / 2)) mod n.
  for (let y = 0; y < height; y++) {
    const shiftedY = (y + Math.floor(height / 2)) % height;
    for (let x = 0; x < width; x++) {
      const shiftedX = (x + Math.floor(width / 2)) % width;
      const value = range ? (magnitude[y * width + x]! - min) / range : 0;
      if (shiftedX < columns) rowSum[shiftedY] += value;
      if (shiftedY < rows) columnSum[shiftedX] += value;
    }
  }
  const scaleRow = detectPeak(smooth1d(normalizeMinMax(rowSum)));
  const scaleColumn = detectPeak(smooth1d(normalizeMinMax(columnSum)));
  if (scaleRow === undefined || scaleColumn === undefined || scaleColumn <= 0 || scaleRow <= 0) return undefined;
  return { gridWidth: (scaleColumn * sourceWidth) / width, gridHeight: (scaleRow * sourceHeight) / height };
}

function smooth1d(values: Float64Array, size = 17): Float64Array {
  if (size % 2 === 0) size++;
  const sigma = size / 6;
  const half = Math.floor(size / 2);
  const kernel = new Float64Array(size);
  let total = 0;
  for (let index = 0; index < size; index++) {
    kernel[index] = Math.exp(-((index - half) ** 2) / (2 * sigma * sigma));
    total += kernel[index]!;
  }
  for (let index = 0; index < size; index++) kernel[index]! /= total + 1e-8;
  const result = new Float64Array(values.length);
  for (let index = 0; index < values.length; index++)
    for (let offset = -half; offset <= half; offset++) {
      const source = index + offset;
      if (source >= 0 && source < values.length) result[index] += values[source]! * kernel[offset + half]!;
    }
  return result;
}

function detectPeak(projection: Float64Array, peakWidth = PEAK_WIDTH, relativeThreshold = 0.35, minDistance = 6): number | undefined {
  const center = Math.floor(projection.length / 2);
  let max = Number.NEGATIVE_INFINITY;
  for (const value of projection) max = Math.max(max, value);
  if (max < 1e-6) return undefined;
  const threshold = max * relativeThreshold;
  const candidates: { index: number; score: number }[] = [];
  for (let index = 1; index < projection.length - 1; index++) {
    let isPeak = true;
    for (let step = 1; step < peakWidth; step++) {
      if (index - step < 0 || index + step >= projection.length) continue;
      if (projection[index - step + 1]! < projection[index - step]! || projection[index + step - 1]! < projection[index + step]!) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak || projection[index]! < threshold) continue;
    let climb = 0;
    for (let step = index; step > 0; step--) {
      if (projection[step]! > projection[step - 1]!) climb = Math.abs(projection[index]! - projection[step - 1]!);
      else break;
    }
    let fall = 0;
    for (let step = index; step < projection.length - 1; step++) {
      if (projection[step]! > projection[step + 1]!) fall = Math.abs(projection[index]! - projection[step + 1]!);
      else break;
    }
    candidates.push({ index, score: Math.max(climb, fall) });
  }
  // Stable sorts by descending score keep the first candidate on ties, as Python does.
  const left = candidates.filter((candidate) => candidate.index < center - minDistance && candidate.index > center * 0.15).sort((a, b) => b.score - a.score);
  const right = candidates.filter((candidate) => candidate.index > center + minDistance && candidate.index < center * 1.85).sort((a, b) => b.score - a.score);
  if (!left.length || !right.length) return undefined;
  return Math.abs(right[0]!.index - left[0]!.index) / 2;
}

function estimateGridGradient(gray: Float32Array, width: number, height: number, relativeThreshold = 0.2): { gridWidth: number; gridHeight: number } | undefined {
  const { gradX, gradY } = gradientSums(gray, width, height);
  const peaks = (values: Float64Array) => {
    let max = 0;
    for (const value of values) max = Math.max(max, value);
    const threshold = relativeThreshold * max;
    const found: number[] = [];
    for (let index = 1; index < values.length - 1; index++)
      if (values[index]! > values[index - 1]! && values[index]! > values[index + 1]! && values[index]! >= threshold && (!found.length || index - found.at(-1)! >= 4))
        found.push(index);
    return found;
  };
  const peakX = peaks(gradX);
  const peakY = peaks(gradY);
  if (peakX.length < 4 || peakY.length < 4) return undefined;
  const median = (values: number[]) => {
    const sorted = values.map((value, index) => index ? value - values[index - 1]! : 0).slice(1).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  return { gridWidth: width / median(peakX), gridHeight: height / median(peakY) };
}

function findBestGrid(origin: number, range: number, gradient: Float64Array): number {
  let best = Math.round(origin);
  let max = 0;
  for (const value of gradient) max = Math.max(max, value);
  if (max < 1e-6) return best;
  let strongest = Number.NEGATIVE_INFINITY;
  for (let offset = -Math.round(range); offset <= Math.round(range); offset++) {
    const candidate = Math.round(origin + offset);
    if (candidate <= 0 || candidate >= gradient.length - 1) continue;
    if (gradient[candidate]! > gradient[candidate - 1]! && gradient[candidate]! > gradient[candidate + 1]! && gradient[candidate]! > strongest) {
      strongest = gradient[candidate]!;
      best = candidate;
    }
  }
  return best;
}

/** Grid lines one cell apart from the centre outwards, each moved to the strongest nearby edge. */
function refineGrid(size: number, cells: number, gradient: Float64Array): number[] {
  const cell = size / cells;
  const coords: number[] = [];
  let line = findBestGrid(size / 2, cell, gradient);
  while (line < size + cell / 2) {
    line = findBestGrid(line, cell * REFINE_INTENSITY, gradient);
    coords.push(line);
    line += cell;
  }
  line = findBestGrid(size / 2, cell, gradient) - cell;
  while (line > -cell / 2 && coords.length <= size / cell) {
    line = findBestGrid(line, cell * REFINE_INTENSITY, gradient);
    coords.push(line);
    line -= cell;
  }
  return coords.sort((a, b) => a - b);
}

function sampleCenter(image: RgbaImage, xCoords: number[], yCoords: number[]): RgbaImage {
  const width = xCoords.length - 1;
  const height = yCoords.length - 1;
  const data = Buffer.alloc(Math.max(0, width * height * 4));
  const clamp = (value: number, size: number) => Math.min(size - 1, Math.max(0, Math.trunc(value)));
  for (let y = 0; y < height; y++) {
    const sourceY = clamp((yCoords[y]! + yCoords[y + 1]!) * 0.5, image.height);
    for (let x = 0; x < width; x++) {
      const sourceX = clamp((xCoords[x]! + xCoords[x + 1]!) * 0.5, image.width);
      const from = (sourceY * image.width + sourceX) * 4;
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

/** An almost square result (one row or column off) becomes square, as the library does by default. */
function fixSquare(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  if (Math.abs(width - height) !== 1) return image;
  const copy = (nextWidth: number, nextHeight: number, source: (x: number, y: number) => number) => {
    const next = Buffer.alloc(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y++)
      for (let x = 0; x < nextWidth; x++) {
        const from = source(x, y) * 4;
        next.set(data.subarray(from, from + 4), (y * nextWidth + x) * 4);
      }
    return { data: next, width: nextWidth, height: nextHeight };
  };
  if (width > height)
    return width % 2 === 1
      ? copy(width - 1, height, (x, y) => y * width + x)
      : copy(width, height + 1, (x, y) => Math.max(0, y - 1) * width + x);
  return height % 2 === 1
    ? copy(width, height - 1, (x, y) => y * width + x)
    : copy(width + 1, height, (x, y) => y * width + Math.max(0, x - 1));
}

/** |2D DFT| of a grey image whose sides are powers of two. */
function fftMagnitude(gray: Float32Array, width: number, height: number): Float64Array {
  const real = Float64Array.from(gray);
  const imaginary = new Float64Array(gray.length);
  const rowReal = new Float64Array(width);
  const rowImaginary = new Float64Array(width);
    for (let y = 0; y < height; y++) {
    rowReal.set(real.subarray(y * width, (y + 1) * width));
    rowImaginary.fill(0);
    fftRadix2(rowReal, rowImaginary, false);
    real.set(rowReal, y * width);
    imaginary.set(rowImaginary, y * width);
  }
  const columnReal = new Float64Array(height);
  const columnImaginary = new Float64Array(height);
    const magnitude = new Float64Array(gray.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      columnReal[y] = real[y * width + x]!;
      columnImaginary[y] = imaginary[y * width + x]!;
    }
    fftRadix2(columnReal, columnImaginary, false);
    for (let y = 0; y < height; y++) magnitude[y * width + x] = Math.hypot(columnReal[y]!, columnImaginary[y]!);
  }
  return magnitude;
}

function fftRadix2(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const size = real.length;
  for (let index = 1, bit = 0; index < size; index++) {
    let mask = size >> 1;
    for (; bit & mask; mask >>= 1) bit ^= mask;
    bit ^= mask;
    if (index < bit) {
      [real[index], real[bit]] = [real[bit]!, real[index]!];
      [imaginary[index], imaginary[bit]] = [imaginary[bit]!, imaginary[index]!];
    }
  }
  for (let length = 2; length <= size; length *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] = real[even]! + oddReal;
        imaginary[even] = imaginary[even]! + oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse)
    for (let index = 0; index < size; index++) {
      real[index]! /= size;
      imaginary[index]! /= size;
    }
}
