import sharp from "sharp";
import { MAX_MEDIA_TOTAL_PIXELS } from "../shared/media-tools.js";
import { ImageGenerationError } from "./openai-image.js";
import { sniffImageType } from "./image-format.js";

export const BACKGROUND_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const decodeOptions = { limitInputPixels: MAX_MEDIA_TOTAL_PIXELS };

/** A normalized snapshot is sent to the provider and retained for local compositing. */
export async function prepareBackgroundImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > BACKGROUND_IMAGE_MAX_BYTES)
    throw new ImageGenerationError(
      "Background removal takes an image of at most 20 MB",
      413,
    );
  if (animatedPng(bytes))
    throw new ImageGenerationError(
      "Background removal takes a single still image",
      400,
    );
  if (!sniffImageType(bytes))
    throw new ImageGenerationError("Choose a PNG, JPEG or WebP image", 400);
  try {
    const image = sharp(bytes, decodeOptions);
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1)
      throw new ImageGenerationError(
        "Background removal takes a single still image",
        400,
      );
    const { data, info } = await image
      .autoOrient()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!data.some((value, index) => index % 4 === 3 && value > 0))
      throw new ImageGenerationError(
        "The source image is fully transparent",
        400,
      );
    const png = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
    if (png.length > BACKGROUND_IMAGE_MAX_BYTES)
      throw new ImageGenerationError("The normalized image exceeds 20 MB", 413);
    return { png, pixels: data, width: info.width, height: info.height };
  } catch (cause) {
    if (cause instanceof ImageGenerationError) throw cause;
    throw new ImageGenerationError(
      "The source image could not be decoded",
      400,
    );
  }
}

/** Use only the returned alpha; a provider cannot repaint or resize the source. */
export async function applyBackgroundAlpha(
  source: Awaited<ReturnType<typeof prepareBackgroundImage>>,
  bytes: Buffer,
): Promise<Buffer> {
  if (animatedPng(bytes))
    throw new ImageGenerationError(
      "Background removal must return a single still PNG",
    );
  if (sniffImageType(bytes) !== "image/png")
    throw new ImageGenerationError(
      "Background removal must return a transparent PNG",
    );
  try {
    const image = sharp(bytes, decodeOptions);
    const metadata = await image.metadata();
    if (
      (metadata.pages ?? 1) !== 1 ||
      !metadata.hasAlpha ||
      metadata.width !== source.width ||
      metadata.height !== source.height
    )
      throw new ImageGenerationError(
        "Background removal must preserve image dimensions and include alpha",
      );
    const alpha = await image
      .toColourspace("srgb")
      .extractChannel("alpha")
      .raw({ depth: "uchar" })
      .toBuffer();
    const pixels = Buffer.from(source.pixels);
    let visible = false,
      transparent = false;
    for (let index = 0; index < alpha.length; index++) {
      const value = Math.round((pixels[index * 4 + 3]! * alpha[index]!) / 255);
      pixels[index * 4 + 3] = value;
      visible ||= value > 0;
      transparent ||= alpha[index]! < 255;
    }
    if (!visible || !transparent)
      throw new ImageGenerationError(
        "Background removal returned an empty image or no transparent background",
      );
    return await sharp(pixels, {
      raw: { width: source.width, height: source.height, channels: 4 },
    })
      .png()
      .toBuffer();
  } catch (cause) {
    if (cause instanceof ImageGenerationError) throw cause;
    throw new ImageGenerationError(
      "The background removal result could not be decoded",
      502,
    );
  }
}

/** libvips exposes only the default frame of APNG, without metadata.pages. */
function animatedPng(bytes: Buffer): boolean {
  if (sniffImageType(bytes) !== "image/png") return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false; // The decoder rejects a truncated file.
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset += length + 12;
  }
  return false;
}
