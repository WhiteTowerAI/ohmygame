import { t } from "./i18n.js";
export async function imageToWebP(file: File): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const maximumWidth = 1600;
    const scale = Math.min(1, maximumWidth / image.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("publish.coverProcessFailed"));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const cover = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
    if (!cover) throw new Error(t("publish.coverProcessFailed"));
    return cover;
  } finally {
    image.close();
  }
}

/** Crops an image to its centred square and scales it to a project logo. */
export async function imageToLogo(file: File): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const side = Math.min(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(256, side);
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("publish.coverProcessFailed"));
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const logo = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!logo) throw new Error(t("publish.coverProcessFailed"));
    return logo;
  } finally {
    image.close();
  }
}
