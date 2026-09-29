/**
 * Screenshots an element of the desktop window as WebP, at device pixel
 * density and at most `maxWidth` pixels wide. Returns `undefined` when capture is unavailable, such as in a
 * browser dev build, or when the element has no size.
 */
export async function captureElementImage(element: Element, maxWidth: number): Promise<Blob | undefined> {
  const capturePage = window.ohMyGameDesktop?.capturePage;
  const bounds = element.getBoundingClientRect();
  if (!capturePage || bounds.width < 1 || bounds.height < 1) return undefined;
  const png = await capturePage({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  const image = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  try {
    const width = Math.min(maxWidth, image.width);
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), "image/webp", 0.8));
  } finally {
    image.close();
  }
}
