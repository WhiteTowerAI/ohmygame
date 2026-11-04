import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { t } from "./i18n.js";
import { TEMPLATE_EXAMPLES_URL } from "./template-assets.js";

/**
 * Template example images live on the asset CDN. A copy of each one seen or
 * used is kept on this device, so templates still open and generate from their
 * examples without a connection.
 */
export interface TemplateExampleStore {
  get(url: string): Promise<Blob | undefined>;
  put(url: string, image: Blob): Promise<void>;
}

const DATABASE = "ohmygame-template-examples";
const IMAGES = "images";

/** IndexedDB works for the packaged app's file:// page as well as the development server. */
function indexedDbStore(): TemplateExampleStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(IMAGES);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    }));
  const run = async <T,>(
    mode: IDBTransactionMode,
    action: (images: IDBObjectStore) => IDBRequest<T>,
  ) => {
    const images = (await open()).transaction(IMAGES, mode).objectStore(IMAGES);
    return new Promise<T>((resolve, reject) => {
      const request = action(images);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: async (url) =>
      (await run("readonly", (images) => images.get(url))) as Blob | undefined,
    put: async (url, image) => {
      await run("readwrite", (images) => images.put(image, url));
    },
  };
}

const NO_STORE: TemplateExampleStore = {
  get: async () => undefined,
  put: async () => undefined,
};
let store: TemplateExampleStore =
  typeof indexedDB === "undefined" ? NO_STORE : indexedDbStore();
const remembered = new Set<string>();

/** Replaces the device store; tests use one in memory. */
export function setTemplateExampleStore(next: TemplateExampleStore): void {
  store = next;
  remembered.clear();
}

export function isTemplateExampleUrl(url: string): boolean {
  return url.startsWith(`${TEMPLATE_EXAMPLES_URL}/`);
}

/** The example image, from the CDN when it can be reached and from this device when it cannot. */
export async function fetchTemplateExample(url: string): Promise<Blob> {
  if (!isTemplateExampleUrl(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(t("assetCanvas.exampleUnavailable"));
    return response.blob();
  }
  try {
    const response = await fetch(url);
    if (response.ok) {
      const image = await response.blob();
      remembered.add(url);
      await store.put(url, image).catch(() => undefined);
      return image;
    }
  } catch {
    // Offline or the CDN is unreachable; the copy on this device is used.
  }
  const saved = await store.get(url).catch(() => undefined);
  if (saved) return saved;
  throw new Error(t("assetCanvas.exampleUnavailable"));
}

/** Keeps a copy of an example shown on screen, once per session. */
export function rememberTemplateExample(url: string): void {
  if (!isTemplateExampleUrl(url) || remembered.has(url)) return;
  remembered.add(url);
  void store
    .get(url)
    .then((saved) => (saved ? undefined : fetchTemplateExample(url)))
    .catch(() => remembered.delete(url));
}

/**
 * An `<img>` for a template example: it keeps a copy once the image shows, and
 * falls back to that copy when the CDN cannot be reached.
 */
export function TemplateExampleImage({
  src,
  onLoad,
  onError,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    setSaved(undefined);
  }, [src]);
  useEffect(
    () => () => {
      if (saved) URL.revokeObjectURL(saved);
    },
    [saved],
  );
  return (
    <img
      {...props}
      src={saved ?? src}
      onLoad={(event) => {
        if (!saved) rememberTemplateExample(src);
        onLoad?.(event);
      }}
      onError={(event) => {
        if (!saved && isTemplateExampleUrl(src)) {
          void store
            .get(src)
            .then((image) => {
              if (image) setSaved(URL.createObjectURL(image));
            })
            .catch(() => undefined);
        }
        onError?.(event);
      }}
    />
  );
}
