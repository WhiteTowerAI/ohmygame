export async function imageToWebP(file: File): Promise<Blob> {
  const image = await createImageBitmap(file);
  try {
    const maximumWidth = 1600;
    const scale = Math.min(1, maximumWidth / image.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not process this cover image");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const cover = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
    if (!cover) throw new Error("Could not process this cover image");
    return cover;
  } finally {
    image.close();
  }
}
