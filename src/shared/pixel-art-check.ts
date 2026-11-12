/** Results of the Canvas pixel-art check; see `src/daemon/pixel-art-check.ts`. */

export type PixelArtCheckId =
  | "size"
  | "alpha"
  | "colors"
  | "isolated"
  | "outline"
  | "baseline"
  | "center";

export interface PixelArtCheckItem {
  id: PixelArtCheckId;
  /** `info` reports a measurement without a requirement to pass. */
  status: "pass" | "fail" | "info";
  value: string;
  expected?: string;
}

export interface PixelArtCheckReport {
  /** Logical size after removing a uniform nearest-neighbour enlargement. */
  width: number;
  height: number;
  scale: number;
  passed: boolean;
  items: PixelArtCheckItem[];
}

export interface PixelArtCheckExpectations {
  width?: number;
  height?: number;
  colors?: number;
  baseline?: number;
  outline?: string;
}

/** Several images checked together: one report each, plus whether they line up. */
export interface PixelArtCheckBatch {
  reports: PixelArtCheckReport[];
  /** Present for two or more images. */
  shared?: { sameSize: boolean; sameBaseline: boolean; colors: number };
}

export function parseHexColor(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return undefined;
  const number = Number.parseInt(match[1]!, 16);
  return [(number >> 16) & 0xff, (number >> 8) & 0xff, number & 0xff];
}
