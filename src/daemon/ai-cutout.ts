import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fetch } from "undici/index.js";
import type { InferenceSession } from "onnxruntime-node";
import type { MediaOutput } from "./media-tools.js";

const MODEL_URL =
  "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
const MODEL_SHA256 =
  "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
const SIZE = 320;
const PIXELS = SIZE * SIZE;

/** Share the model/session within the daemon, and allow retry after a failed download. */
export function createAiCutout(modelDirectory: string) {
  let session: Promise<InferenceSession> | undefined;
  const load = async () => {
    const modelPath = path.join(modelDirectory, "u2netp.onnx");
    const valid = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex") === MODEL_SHA256;
    let model: Buffer | undefined;
    try {
      model = await readFile(modelPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!model || !valid(model)) {
      const response = await fetch(MODEL_URL, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw new Error(
          `AI cutout model download failed (${response.status}). Please retry.`,
        );
      model = Buffer.from(await response.arrayBuffer());
      if (!valid(model))
        throw new Error("AI cutout model checksum mismatch. Please retry.");
      await mkdir(modelDirectory, { recursive: true });
      const temporary = `${modelPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, model);
        await rename(temporary, modelPath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const { InferenceSession } = await import("onnxruntime-node");
    return InferenceSession.create(model, {
      executionProviders: ["cpu"],
      intraOpNumThreads: 2,
    });
  };
  return async (inputPath: string): Promise<MediaOutput> => {
    session ??= load().catch((error) => {
      session = undefined;
      throw error;
    });
    const model = await session;
    const { Tensor } = await import("onnxruntime-node");
    const source = sharp(inputPath, { limitInputPixels: 100_000_000 })
      .autoOrient()
      .toColourspace("srgb")
      .ensureAlpha();
    const { data, info } = await source
      .clone()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgb = await source
      .clone()
      .removeAlpha()
      .resize(SIZE, SIZE, { fit: "fill" })
      .raw()
      .toBuffer();
    let maximum = 1;
    for (const channel of rgb) maximum = Math.max(maximum, channel);
    const input = new Float32Array(3 * PIXELS);
    const means = [0.485, 0.456, 0.406];
    const deviations = [0.229, 0.224, 0.225];
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        input[channel * PIXELS + pixel] =
          (rgb[pixel * 3 + channel]! / maximum - means[channel]!) /
          deviations[channel]!;
      }
    }
    const prediction = await model.run({
      [model.inputNames[0]!]: new Tensor("float32", input, [1, 3, SIZE, SIZE]),
    });
    const values = prediction[model.outputNames[0]!]!.data as Float32Array;
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < PIXELS; index++) {
      min = Math.min(min, values[index]!);
      max = Math.max(max, values[index]!);
    }
    const mask = Buffer.alloc(PIXELS);
    for (let index = 0; index < PIXELS; index++)
      mask[index] =
        max > min
          ? Math.round(((values[index]! - min) / (max - min)) * 255)
          : 0;
    const alpha = await sharp(mask, {
      raw: { width: SIZE, height: SIZE, channels: 1 },
    })
      .resize(info.width, info.height, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    for (let pixel = 0; pixel < alpha.length; pixel++)
      data[pixel * 4 + 3] = Math.round(
        (data[pixel * 4 + 3]! * alpha[pixel]!) / 255,
      );
    const bytes = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
    return { name: "ai-cutout.png", bytes, mediaType: "image/png" };
  };
}
