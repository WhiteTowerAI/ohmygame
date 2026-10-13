import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { object, wireImages, type Json, type WireImage } from "./session-images.js";

const FILE_TTL_SECONDS = 7 * 24 * 60 * 60;
const VERIFICATION_MS = 5 * 60 * 1000;
interface CachedFile { id: string; bytes: number; expiresAt: number; verifiedAt: number }
interface Pending { promise: Promise<CachedFile>; controller: AbortController; waiters: number }
const pending = new Map<string, Pending>();
const mutations = new Map<string, Promise<void>>();
async function mutate(file: string, action: () => Promise<void>): Promise<void> {
  const previous = mutations.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  mutations.set(file, operation);
  try { await operation; } finally { if (mutations.get(file) === operation) mutations.delete(file); }
}
export interface UsedOpenAIFile { path: string; id: string }
export const openAIRequestScope = (headers: Headers): string => createHash("sha256").update(JSON.stringify(
  [headers.get("authorization"), headers.get("openai-organization"), headers.get("openai-project")])).digest("hex");

/** This API is enabled only for Platform API keys at the official Responses endpoint. */
export class OpenAISessionFiles {
  constructor(private readonly directory: string) {}

  async replace(payload: Json, headers: Headers, delegate: typeof fetch, signal: AbortSignal): Promise<UsedOpenAIFile[]> {
    const images = wireImages(payload).filter((image) => image.file);
    if (images.length > 1500 || images.reduce((total, image) => total + Buffer.byteLength(image.data, "base64"), 0) > 512 * 1024 * 1024) {
      throw new Error("OpenAI image files exceed the request image limit");
    }
    const replacements: Array<{ image: WireImage; file: UsedOpenAIFile }> = [];
    const scope = openAIRequestScope(headers);
    let next = 0;
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    // Resolve every upload before changing the payload, so inline fallback stays intact.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, images.length) }, async () => {
      try {
        while (next < images.length) {
          const image = images[next++];
          operationSignal.throwIfAborted();
          const bytes = Buffer.from(image.data, "base64");
          const hash = createHash("sha256").update(image.mime).update(bytes).digest("hex");
          const cachePath = path.join(this.directory, scope, `${hash}.json`);
          const file = await this.resolve(cachePath, bytes, image.mime, headers, delegate, operationSignal);
          replacements.push({ image, file: { path: cachePath, id: file.id } });
        }
      } catch (error) { controller.abort(error); throw error; }
    }));
    signal.throwIfAborted();
    const failure = workers.find((worker) => worker.status === "rejected");
    if (failure) throw failure.reason;
    const used = new Map<string, UsedOpenAIFile>();
    for (const { image, file } of replacements) { image.file!(file.id); used.set(`${file.path}\0${file.id}`, file); }
    return [...used.values()];
  }

  async invalidate(files: UsedOpenAIFile[]): Promise<void> {
    await Promise.all(files.map((file) => mutate(file.path, async () => {
      const cached = await this.read(file.path);
      if (cached?.id === file.id) await rm(file.path, { force: true });
    })));
  }

  private async resolve(cachePath: string, bytes: Buffer, mime: string, headers: Headers, delegate: typeof fetch, signal: AbortSignal): Promise<CachedFile> {
    let operation = pending.get(cachePath);
    if (!operation) {
      const controller = new AbortController();
      operation = { controller, waiters: 0,
        promise: this.load(cachePath, bytes, mime, headers, delegate, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])) };
      pending.set(cachePath, operation);
      const captured = operation;
      void operation.promise.finally(() => { if (pending.get(cachePath) === captured) pending.delete(cachePath); }).catch(() => {});
    }
    operation.waiters++;
    try {
      signal.throwIfAborted();
      return await new Promise<CachedFile>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void operation!.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    } finally {
      if (--operation.waiters === 0 && pending.get(cachePath) === operation) {
        pending.delete(cachePath); operation.controller.abort();
      }
    }
  }

  private async load(cachePath: string, bytes: Buffer, mime: string, incoming: Headers, delegate: typeof fetch, signal: AbortSignal): Promise<CachedFile> {
    const headers = new Headers();
    for (const name of ["authorization", "openai-organization", "openai-project"]) {
      const value = incoming.get(name); if (value) headers.set(name, value);
    }
    const cached = await this.read(cachePath);
    if (cached && cached.bytes === bytes.length && cached.expiresAt > Date.now() / 1000 + 60) {
      if (Date.now() - cached.verifiedAt < VERIFICATION_MS) return cached;
      const response = await delegate(`https://api.openai.com/v1/files/${encodeURIComponent(cached.id)}`, { headers, signal, redirect: "error" });
      if (response.ok) {
        const metadata: unknown = await response.json();
        if (object(metadata) && metadata.id === cached.id && metadata.bytes === bytes.length) {
          const verified = { ...cached, verifiedAt: Date.now(), expiresAt: typeof metadata.expires_at === "number" && metadata.expires_at > 0 ? metadata.expires_at : cached.expiresAt };
          if (verified.expiresAt > Date.now() / 1000 + 60) { await this.write(cachePath, verified, cached.id); return verified; }
        }
      } else {
        await response.body?.cancel();
        if (response.status !== 404 && response.status !== 410) throw new Error(`OpenAI file verification failed (HTTP ${response.status})`);
      }
    }
    const form = new FormData();
    form.append("purpose", "vision");
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", String(FILE_TTL_SECONDS));
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `image.${mime.split("/")[1]}`);
    const response = await delegate("https://api.openai.com/v1/files", { method: "POST", headers, body: form, signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenAI image upload failed (HTTP ${response.status})`); }
    const metadata: unknown = await response.json();
    if (!object(metadata) || typeof metadata.id !== "string" || !/^file-[\w-]+$/.test(metadata.id) || metadata.bytes !== bytes.length) throw new Error("OpenAI returned invalid file metadata");
    const file = { id: metadata.id, bytes: bytes.length, verifiedAt: Date.now(),
      expiresAt: typeof metadata.expires_at === "number" && metadata.expires_at > 0 ? metadata.expires_at : Date.now() / 1000 + FILE_TTL_SECONDS };
    await this.write(cachePath, file); return file;
  }

  private async read(file: string): Promise<CachedFile | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (object(value) && typeof value.id === "string" && /^file-[\w-]+$/.test(value.id)
        && typeof value.bytes === "number" && typeof value.expiresAt === "number" && typeof value.verifiedAt === "number") return value as unknown as CachedFile;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }

  private async write(file: string, value: CachedFile, expectedId?: string): Promise<void> {
    await mutate(file, async () => {
      if (expectedId && (await this.read(file))?.id !== expectedId) return;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    });
  }
}

export async function rejectedOpenAIFiles(response: Response, used: UsedOpenAIFile[]): Promise<boolean> {
  if (!used.length || ![400, 404, 410].includes(response.status)) return false;
  const body: unknown = await response.clone().json().catch(() => undefined);
  if (!object(body) || !object(body.error)) return false;
  return isRejectedOpenAIFileError(body.error, used);
}

export function isRejectedOpenAIFileError(error: unknown, used: UsedOpenAIFile[]): boolean {
  if (!used.length || !object(error)) return false;
  const message = typeof error.message === "string" ? error.message : "";
  return typeof error.code === "string" && /^(file_not_found|file_expired)$/.test(error.code)
    || used.some((file) => message.includes(file.id)) && /not found|expired|does not exist/i.test(message);
}
