import { createContext, createElement, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

type LoadImage = (signal: AbortSignal) => Promise<Blob | undefined>;
type ImagePreview = { url?: string; error?: string; loading: boolean };
type ReadyImage = { blob: Blob; url: string };
type ImageEntry = {
  snapshot: ImagePreview;
  listeners: Set<() => void>;
  revision?: string | number;
  request?: AbortController;
  ready?: ReadyImage;
};

const IDLE: ImagePreview = { loading: false };
const LOADING: ImagePreview = { loading: true };

/** Shares image reads within a preview. An image can move to a new Markdown node in the same commit. */
export class ImagePreviews {
  readonly #entries = new Map<string, ImageEntry>();

  read(key: string): ImagePreview {
    return this.#entries.get(key)?.snapshot ?? LOADING;
  }

  subscribe(key: string, listener: () => void): () => void {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { snapshot: LOADING, listeners: new Set() };
      this.#entries.set(key, entry);
    }
    const current = entry;
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
      queueMicrotask(() => {
        if (current.listeners.size || this.#entries.get(key) !== current) return;
        this.#entries.delete(key);
        current.request?.abort();
        if (current.ready) URL.revokeObjectURL(current.ready.url);
      });
    };
  }

  load(key: string, revision: string | number, load: LoadImage, retry = false): void {
    const entry = this.#entries.get(key);
    if (!entry || (!retry && entry.revision === revision)) return;
    entry.request?.abort();
    const request = new AbortController();
    entry.request = request;
    entry.revision = revision;
    this.#publish(entry, { url: entry.ready?.url, loading: true });
    void this.#replace(entry, request.signal, load);
  }

  async #replace(entry: ImageEntry, signal: AbortSignal, load: LoadImage): Promise<void> {
    let candidate: string | undefined;
    const discard = () => {
      if (candidate) URL.revokeObjectURL(candidate);
      candidate = undefined;
    };
    signal.addEventListener("abort", discard, { once: true });
    try {
      const blob = await load(signal);
      if (signal.aborted) return;
      if (!blob) {
        this.#ready(entry, undefined);
        return;
      }
      const previous = entry.ready;
      const unchanged = previous && await sameBytes(previous.blob, blob, signal);
      if (signal.aborted) return;
      if (unchanged) {
        this.#publish(entry, { url: previous.url, loading: false });
        return;
      }
      candidate = URL.createObjectURL(blob);
      if (previous) {
        const image = new Image();
        image.src = candidate;
        await image.decode();
      }
      if (signal.aborted) return;
      const next = { blob, url: candidate };
      candidate = undefined;
      this.#ready(entry, next);
    } catch (cause) {
      if (signal.aborted) return;
      const status = cause instanceof Error && "status" in cause ? cause.status : undefined;
      const error = cause instanceof Error ? cause.message : String(cause);
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 410) this.#ready(entry, undefined, error);
      else this.#publish(entry, { url: entry.ready?.url, error, loading: false });
    } finally {
      signal.removeEventListener("abort", discard);
      discard();
    }
  }

  #ready(entry: ImageEntry, image: ReadyImage | undefined, error?: string): void {
    const previous = entry.ready;
    entry.ready = image;
    this.#publish(entry, { url: image?.url, error, loading: false });
    if (previous) URL.revokeObjectURL(previous.url);
  }

  #publish(entry: ImageEntry, snapshot: ImagePreview): void {
    const previous = entry.snapshot;
    if (previous.url === snapshot.url && previous.error === snapshot.error && previous.loading === snapshot.loading) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }
}

const ImagePreviewScope = createContext<ImagePreviews | null>(null);
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(() => new ImagePreviews());
  return createElement(ImagePreviewScope.Provider, { value: scope }, children);
}

export function useImagePreview(key: string | undefined, revision: string | number, load: LoadImage, shared?: ImagePreviews) {
  const parent = useContext(ImagePreviewScope);
  const [local] = useState(() => shared ?? parent ?? new ImagePreviews());
  const scope = shared ?? parent ?? local;
  const subscribe = useCallback((listener: () => void) => key ? scope.subscribe(key, listener) : () => {}, [key, scope]);
  const read = () => key ? scope.read(key) : IDLE;
  const preview = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { if (key) scope.load(key, revision, load); }, [scope, key, revision, load]);
  return { ...preview, retry: () => { if (key) scope.load(key, revision, load, true); } };
}

async function sameBytes(left: Blob, right: Blob, signal: AbortSignal): Promise<boolean> {
  if (left === right) return true;
  if (left.size !== right.size || left.type !== right.type) return false;
  const chunkSize = 256 * 1024;
  for (let offset = 0; offset < left.size; offset += chunkSize) {
    if (signal.aborted) return false;
    const [a, b] = await Promise.all([
      left.slice(offset, offset + chunkSize).arrayBuffer(),
      right.slice(offset, offset + chunkSize).arrayBuffer(),
    ]);
    const rightBytes = new Uint8Array(b);
    if (!new Uint8Array(a).every((byte, index) => byte === rightBytes[index])) return false;
  }
  return true;
}
