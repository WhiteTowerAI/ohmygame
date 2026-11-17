/**
 * Screenshots an element of the desktop window as WebP, at device pixel
 * density and at most `maxWidth` pixels wide, optionally drawn over. Returns `undefined` when capture is unavailable, such as in a
 * browser dev build, or when the element has no size.
 */
export async function captureElementImage(
  element: Element,
  maxWidth: number,
  /** Draws over the capture, in the output image's pixels. */
  annotate?: (context: CanvasRenderingContext2D, width: number, height: number) => void,
  capture?: () => Promise<Uint8Array>,
): Promise<Blob | undefined> {
  return (await captureElement(element, maxWidth, annotate, capture))?.blob;
}

/** `captureElementImage` with the image's size in pixels. */
export async function captureElement(
  element: Element,
  maxWidth: number,
  annotate?: (context: CanvasRenderingContext2D, width: number, height: number) => void,
  capture?: () => Promise<Uint8Array>,
): Promise<{ blob: Blob; width: number; height: number } | undefined> {
  const capturePage = window.ohMyGameDesktop?.capturePage;
  const bounds = element.getBoundingClientRect();
  if ((!capture && !capturePage) || bounds.width < 1 || bounds.height < 1) return undefined;
  // The game's own capture is JPEG and the window's is PNG; decoding reads the format from the bytes.
  const encoded = capture ? await capture() : await capturePage!({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  const image = await createImageBitmap(new Blob([encoded as BlobPart]));
  try {
    const width = Math.min(maxWidth, image.width);
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context?.drawImage(image, 0, 0, width, height);
    if (context) annotate?.(context, width, height);
    const blob = await new Promise<Blob | undefined>((resolve) => canvas.toBlob((value) => resolve(value ?? undefined), "image/webp", 0.8));
    return blob && { blob, width, height };
  } finally {
    image.close();
  }
}

/** Resolves after the next paint, or soon in a window that isn't painting, such as a hidden one. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve();
    }));
  });
}

export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
