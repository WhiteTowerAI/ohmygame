import sharp from "sharp";
import { expect, it } from "vitest";
import { checkPixelArt, checkPixelArtImages } from "../src/daemon/pixel-art-check.js";

type Paint = (x: number, y: number) => readonly [number, number, number, number];

async function png(width: number, height: number, paint: Paint): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set(paint(x, y), (y * width + x) * 4);
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const BODY = [200, 60, 60, 255] as const;
const CLEAR = [0, 0, 0, 0] as const;

it("measures an enlarged sprite on its own pixel grid", async () => {
  const sprite = await png(8, 8, (x, y) => y >= 2 && y <= 6 && x >= 2 && x <= 5 ? (x === 2 || x === 5 || y === 2 || y === 6 ? [27, 25, 29, 255] : BODY) : CLEAR);
  const enlarged = await sharp(sprite).resize(64, 64, { kernel: "nearest" }).png().toBuffer();
  const report = await checkPixelArt(enlarged, { width: 8, height: 8, colors: 2, baseline: 6, outline: "#1b191d" });
  expect(report).toMatchObject({ width: 8, height: 8, scale: 8, passed: true });
  expect(Object.fromEntries(report.items.map((item) => [item.id, item.status]))).toEqual({
    size: "pass", alpha: "pass", colors: "pass", isolated: "pass", outline: "pass", baseline: "pass", center: "info",
  });
  const failing = await checkPixelArt(enlarged, { width: 12, height: 12, colors: 1, baseline: 7 });
  expect(failing.passed).toBe(false);
  expect(failing.items.filter((item) => item.status === "fail").map((item) => item.id)).toEqual(["size", "colors", "baseline"]);
});

it("reports semi-transparent pixels, lone pixels, and whether images line up", async () => {
  const soft = await png(8, 8, (x, y) => x === 3 && y === 3 ? [200, 60, 60, 128] : (x + y) % 2 ? [x * 30, y * 30, 50, 255] : CLEAR);
  const report = await checkPixelArt(soft);
  expect(report.items.find((item) => item.id === "alpha")).toMatchObject({ status: "fail" });
  expect(report.items.find((item) => item.id === "isolated")).toMatchObject({ status: "fail" });
  const low = await png(8, 8, (_x, y) => y === 7 ? BODY : CLEAR);
  const high = await png(8, 8, (_x, y) => y === 5 ? BODY : CLEAR);
  expect((await checkPixelArtImages([low, high])).shared).toEqual({ sameSize: true, sameBaseline: false, colors: 1 });
  expect((await checkPixelArtImages([low])).shared).toBeUndefined();
});
