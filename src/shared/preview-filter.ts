// A plugin's preview filter: a colour matrix over the game as the person sees
// it, such as a colour-vision simulation. Only red, green and blue change;
// alpha is kept. Screenshots, covers and recordings stay unfiltered.

export const PREVIEW_FILTER_COLOR_SPACES = ["linearRGB", "sRGB"] as const;
export type PreviewFilterColorSpace = (typeof PREVIEW_FILTER_COLOR_SPACES)[number];

export interface PreviewColorFilter {
  /** The space the matrix works in, as SVG's `color-interpolation-filters`. */
  colorSpace: PreviewFilterColorSpace;
  /** Rows for red, green and blue, each over red, green and blue in. */
  matrix: number[][];
  /** Added to red, green and blue after the matrix. */
  offset?: number[];
}

export const PREVIEW_FILTER_MAX_COEFFICIENT = 4;

const finite = (value: unknown, limit: number) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

const triple = (value: unknown, limit: number) =>
  Array.isArray(value) && value.length === 3 && value.every((item) => finite(item, limit));

/** Whether `value` is a filter the game host can apply, as it is sent across. */
export function isPreviewColorFilter(value: unknown): value is PreviewColorFilter {
  if (!value || typeof value !== "object") return false;
  const filter = value as Partial<PreviewColorFilter>;
  return PREVIEW_FILTER_COLOR_SPACES.includes(filter.colorSpace as PreviewFilterColorSpace) &&
    Array.isArray(filter.matrix) && filter.matrix.length === 3 &&
    filter.matrix.every((row) => triple(row, PREVIEW_FILTER_MAX_COEFFICIENT)) &&
    (filter.offset === undefined || triple(filter.offset, 1));
}

/** The filter as `feColorMatrix` values: four rows of five, alpha passed through. */
export function colorMatrixValues(filter: PreviewColorFilter): string {
  const rows = filter.matrix.map((row, index) => [...row, 0, filter.offset?.[index] ?? 0]);
  return [...rows, [0, 0, 0, 1, 0]].map((row) => row.join(" ")).join(" ");
}
