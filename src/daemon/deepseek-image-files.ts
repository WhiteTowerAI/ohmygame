import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createReadToolDefinition,
  type AgentSession,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

const ORIGIN = "https://api.deepseek.com";
export const DEEPSEEK_REQUEST_LIMIT = 48 * 1024 * 1024;
export const DEEPSEEK_FILE_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const IMAGE_LIMIT = 64 * 1024 * 1024;
const INLINE_IMAGE_LIMIT = 32 * 1024 * 1024;
const FILE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const FILE_TIMEOUT_MS = 120_000;
type JsonObject = Record<string, unknown>;
interface CachedFile {
  id: string;
  bytes: number;
  expiresAt: number;
  verifiedAt?: number;
}
interface PendingFile {
  promise: Promise<CachedFile>;
  controller: AbortController;
  waiters: number;
}
interface DecodedImage {
  bytes: Buffer;
  mime: string;
  hash: string;
}
interface InlineImage extends DecodedImage {
  block: JsonObject;
  responses: boolean;
}
interface UsedFile {
  cachePath: string;
  id: string;
}

// Shared across sessions, but never across credentials. Only active operations live in memory.
const pendingFiles = new Map<string, PendingFile>();
const cacheUpdates = new Map<string, Promise<void>>();

class FilesUnavailableError extends Error {}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin === ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return url;
  } catch {
    /* Other providers are unaffected. */
  }
  return undefined;
}

export function isDeepSeekFileModel(
  model: { api?: string; baseUrl?: string } | undefined,
): boolean {
  if (model?.api !== "openai-completions" && model?.api !== "openai-responses")
    return false;
  const url = officialUrl(model.baseUrl ?? "");
  return !!url && /^\/(?:v1\/?|beta\/?)?$/.test(url.pathname);
}

/** Read images at their original size for DeepSeek; evaluate the setting at tool execution time. */
export function createProviderImageReadTool(
  cwd: string,
  settings: SettingsManager,
): ReturnType<typeof createReadToolDefinition> {
  const resized = createReadToolDefinition(cwd, { autoResizeImages: true });
  const original = createReadToolDefinition(cwd, { autoResizeImages: false });
  return {
    ...resized,
    execute: (...args: Parameters<typeof resized.execute>) => {
      const autoResize =
        !isDeepSeekFileModel(args[4].model) && settings.getImageAutoResize();
      return (autoResize ? resized : original).execute(...args);
    },
  };
}

/** Install on the session, leaving the shared ModelRuntime and persisted settings untouched. */
export function installDeepSeekImageFiles(
  session: AgentSession,
  agentDir: string,
): void {
  const getAutoResize = session.settingsManager.getImageAutoResize.bind(
    session.settingsManager,
  );
  session.settingsManager.getImageAutoResize = () =>
    isDeepSeekFileModel(session.model) ? false : getAutoResize();
  const files = new DeepSeekImageFiles(
    path.join(agentDir, "deepseek-image-files"),
  );
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    if (model.api !== "openai-completions" && model.api !== "openai-responses")
      return stream(model, context, options);
    return stream(model, context, {
      ...options,
      fetch: files.wrapFetch(options?.fetch ?? globalThis.fetch),
    });
  };
}

/**
 * Work on the final HTTP body so extensions, authentication overrides and SDK retries
 * are preserved. Never change the canonical images in the transcript. DeepSeek docs:
 * https://api-docs.deepseek.com/guides/vision
 * https://api-docs.deepseek.com/guides/files_api
 */
export class DeepSeekImageFiles {
  constructor(private readonly cacheDir: string) {}

  wrapFetch(delegate: typeof fetch): typeof fetch {
    return async (input, init) => {
      const url = officialUrl(
        input instanceof Request ? input.url : String(input),
      );
      if (
        !url ||
        !/^\/(?:v1\/|beta\/)?(?:chat\/completions|responses)$/.test(
          url.pathname,
        )
      ) {
        return delegate(input, init);
      }
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const inputHeaders = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (
        method.toUpperCase() !== "POST" ||
        !inputHeaders.get("content-type")?.includes("application/json")
      ) {
        return delegate(input, init);
      }
      const request = new Request(input, init);
      let originalBody: string;
      let payload: JsonObject;
      let parts: InlineImage[];
      try {
        request.signal.throwIfAborted();
        originalBody = await request.text();
        const parsed: unknown = JSON.parse(originalBody);
        if (!object(parsed))
          throw new Error("DeepSeek request must be a JSON object.");
        payload = parsed;
        parts = collectImages(payload);
      } catch (error) {
        if (request.signal.aborted) throw error;
        return localError(error);
      }
      const originalBytes = Buffer.byteLength(originalBody);
      if (!parts.length) {
        request.signal.throwIfAborted();
        if (originalBytes > DEEPSEEK_REQUEST_LIMIT)
          return localError(requestSizeError(originalBytes));
        return delegate(modelRequest(request, originalBody));
      }
      const inlineFits =
        originalBytes <= DEEPSEEK_REQUEST_LIMIT &&
        parts.every((part) => part.bytes.length <= INLINE_IMAGE_LIMIT);
      for (let attempt = 0; ; attempt++) {
        let used: UsedFile[];
        let outgoing: Request;
        try {
          request.signal.throwIfAborted();
          used = await this.replaceImages(
            parts,
            request.headers,
            request.signal,
            delegate,
          );
          const body = JSON.stringify(payload);
          const bytes = Buffer.byteLength(body);
          if (bytes > DEEPSEEK_REQUEST_LIMIT) {
            throw requestSizeError(bytes);
          }
          outgoing = modelRequest(request, body);
        } catch (error) {
          if (request.signal.aborted) throw error;
          if (error instanceof FilesUnavailableError) {
            // Restore the exact incoming body, including every image and all history.
            if (inlineFits)
              return delegate(modelRequest(request, originalBody));
            const reason =
              originalBytes > DEEPSEEK_REQUEST_LIMIT
                ? `The complete original-image request is ${(originalBytes / 1024 / 1024).toFixed(2)} MiB, exceeding the 48 MiB request limit.`
                : "An original image exceeds DeepSeek's 32 MiB inline image limit.";
            return localError(
              new Error(
                `${error.message} Inline fallback is unavailable. ${reason} All original content was retained locally.`,
              ),
            );
          }
          return localError(error);
        }
        // Model network errors retain the SDK's normal retry handling.
        const response = await delegate(outgoing);
        const rejected = await rejectedFiles(response, used);
        request.signal.throwIfAborted();
        if (!rejected.length) return response;
        try {
          await Promise.all(
            rejected.map(({ cachePath, id }) =>
              updateCache(cachePath, (current) =>
                current?.id === id
                  ? { ...current, expiresAt: 0, verifiedAt: 0 }
                  : undefined,
              ),
            ),
          );
          request.signal.throwIfAborted();
        } catch (error) {
          if (request.signal.aborted) throw error;
          return localError(error);
        }
        // Invalidate on both failures, but recover only once per logical fetch.
        if (attempt >= 1) return response;
        void response.body?.cancel().catch(() => {});
      }
    };
  }

  private async replaceImages(
    parts: InlineImage[],
    headers: Headers,
    signal: AbortSignal,
    delegate: typeof fetch,
  ): Promise<UsedFile[]> {
    if (!parts.length) return [];
    const authorization = headers.get("authorization");
    if (!authorization)
      throw new Error(
        "DeepSeek image upload requires the request's Authorization header.",
      );
    const accountDir = path.join(
      this.cacheDir,
      digest(`${ORIGIN}\n${authorization}`),
    );
    const unique = [
      ...new Map(parts.map((part) => [part.hash, part])).values(),
    ];
    const references = new Map<string, string>();
    const used: UsedFile[] = [];
    let next = 0;
    // Bound upload/metadata requests even for a long image-heavy history.
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, unique.length) }, async () => {
          while (next < unique.length) {
            operationSignal.throwIfAborted();
            const part = unique[next++];
            const cachePath = path.join(accountDir, `${part.hash}.json`);
            const file = await this.file(
              cachePath,
              part.bytes,
              part.mime,
              authorization,
              operationSignal,
              delegate,
            );
            references.set(part.hash, file.id);
            used.push({ cachePath, id: file.id });
          }
        }),
      );
    } catch (error) {
      controller.abort();
      throw error;
    }
    for (const part of parts) {
      const fileId = references.get(part.hash)!;
      if (part.responses) {
        delete part.block.image_url;
        part.block.file_id = fileId;
      } else {
        // DeepSeek's Chat Completions file block is flat, unlike OpenAI's file block.
        delete part.block.image_url;
        part.block.type = "file";
        part.block.file_id = fileId;
      }
    }
    return used;
  }

  private async file(
    cachePath: string,
    bytes: Buffer,
    mime: string,
    authorization: string,
    signal: AbortSignal,
    delegate: typeof fetch,
  ): Promise<CachedFile> {
    signal.throwIfAborted();
    let pending = pendingFiles.get(cachePath);
    if (!pending) {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(FILE_TIMEOUT_MS);
      const operationSignal = AbortSignal.any([controller.signal, timeout]);
      pending = {
        controller,
        waiters: 0,
        promise: this.loadOrUpload(
          cachePath,
          bytes,
          mime,
          authorization,
          operationSignal,
          delegate,
        ).catch((error) => {
          if (timeout.aborted && operationSignal.reason === timeout.reason) {
            throw new FilesUnavailableError(
              "DeepSeek image file resolution timed out.",
              { cause: error },
            );
          }
          throw error;
        }),
      };
      pendingFiles.set(cachePath, pending);
      const entry = pending;
      void entry.promise
        .finally(() => {
          if (pendingFiles.get(cachePath) === entry)
            pendingFiles.delete(cachePath);
        })
        .catch(() => {});
    }
    pending.waiters++;
    try {
      return await cancellable(pending.promise, signal);
    } finally {
      if (--pending.waiters === 0 && pendingFiles.get(cachePath) === pending) {
        pendingFiles.delete(cachePath);
        pending.controller.abort();
      }
    }
  }

  private async loadOrUpload(
    cachePath: string,
    bytes: Buffer,
    mime: string,
    authorization: string,
    signal: AbortSignal,
    delegate: typeof fetch,
  ): Promise<CachedFile> {
    const cached = await readCache(cachePath);
    signal.throwIfAborted();
    const now = Date.now();
    if (
      cached &&
      cached.bytes === bytes.length &&
      cached.expiresAt > now / 1000 + 60
    ) {
      if (
        cached.verifiedAt !== undefined &&
        cached.verifiedAt <= now &&
        now - cached.verifiedAt < DEEPSEEK_FILE_VERIFICATION_TTL_MS
      )
        return cached;
      const response = await fileRequest(
        delegate,
        `${ORIGIN}/files/${encodeURIComponent(cached.id)}`,
        {
          headers: { authorization },
          signal,
          redirect: "error",
        },
        "file verification",
      );
      if (response.ok) {
        const metadata = await fileMetadata(response);
        if (
          object(metadata) &&
          metadata.id === cached.id &&
          metadata.bytes === bytes.length &&
          (typeof metadata.expires_at !== "number" ||
            metadata.expires_at > Date.now() / 1000 + 60)
        ) {
          const verified = {
            ...cached,
            verifiedAt: Date.now(),
            expiresAt:
              typeof metadata.expires_at === "number"
                ? Math.min(cached.expiresAt, metadata.expires_at)
                : cached.expiresAt,
          };
          await updateCache(cachePath, (current) =>
            current?.id === cached.id &&
            current.expiresAt > Date.now() / 1000 + 60
              ? verified
              : undefined,
          );
          return verified;
        }
      } else if (response.status !== 404 && response.status !== 410) {
        throw fileHttpError(response, "file verification");
      } else {
        void response.body?.cancel().catch(() => {});
      }
    }
    signal.throwIfAborted();
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", String(FILE_LIFETIME_SECONDS));
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      `image.${mime.split("/")[1]}`,
    );
    const response = await fileRequest(
      delegate,
      `${ORIGIN}/files`,
      {
        method: "POST",
        headers: { authorization },
        body: form,
        signal,
        redirect: "error",
      },
      "image upload",
    );
    if (!response.ok) throw fileHttpError(response, "image upload");
    const metadata = await fileMetadata(response);
    if (
      !object(metadata) ||
      typeof metadata.id !== "string" ||
      !/^file-api-[a-zA-Z0-9_-]+$/.test(metadata.id) ||
      metadata.bytes !== bytes.length ||
      typeof metadata.expires_at !== "number" ||
      metadata.expires_at <= Date.now() / 1000 + 60
    ) {
      throw new Error(
        "DeepSeek returned invalid image file metadata; the model request was not sent.",
      );
    }
    const file: CachedFile = {
      id: metadata.id,
      bytes: bytes.length,
      expiresAt: metadata.expires_at,
      verifiedAt: Date.now(),
    };
    await updateCache(cachePath, () => file);
    return file;
  }
}

function validFile(value: unknown): value is CachedFile {
  return (
    object(value) &&
    typeof value.id === "string" &&
    /^file-api-[a-zA-Z0-9_-]+$/.test(value.id) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    (value.verifiedAt === undefined ||
      (typeof value.verifiedAt === "number" &&
        Number.isFinite(value.verifiedAt)))
  );
}

function collectImages(payload: JsonObject): InlineImage[] {
  const parts: InlineImage[] = [];
  const decoded = new Map<string, DecodedImage>();
  const items = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  for (const item of items) {
    if (!object(item)) continue;
    for (const content of [item.content, item.output]) {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!object(block)) continue;
        const url =
          block.type === "image_url" && object(block.image_url)
            ? block.image_url.url
            : block.type === "input_image"
              ? block.image_url
              : undefined;
        if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
        let image = decoded.get(url);
        if (!image) {
          const match =
            /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
              url,
            );
          if (!match || !match[2] || match[2].length % 4 !== 0)
            throw new Error(
              "Invalid inline image; the original image was retained locally.",
            );
          const bytes = Buffer.from(match[2], "base64");
          if (bytes.length > IMAGE_LIMIT)
            throw new Error(
              "DeepSeek Files API accepts images up to 64 MiB. The original image was retained locally.",
            );
          image = {
            bytes,
            mime: match[1].toLowerCase().replace("image/jpg", "image/jpeg"),
            hash: digest(bytes),
          };
          decoded.set(url, image);
        }
        parts.push({
          block,
          ...image,
          responses: block.type === "input_image",
        });
      }
    }
  }
  if (
    parts.length > 600 ||
    parts.reduce((sum, part) => sum + part.bytes.length, 0) > 200 * 1024 * 1024
  ) {
    throw new Error(
      "DeepSeek accepts at most 600 images / 200 MiB of image files per request. No images were removed.",
    );
  }
  return parts;
}

function modelRequest(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body });
}

function requestSizeError(bytes: number): Error {
  return new Error(
    `DeepSeek request is ${(bytes / 1024 / 1024).toFixed(2)} MiB; the limit is 48 MiB. Text/history is too large. No content was removed; the request was not sent.`,
  );
}

function localError(error: unknown): Response {
  // Preserve a specific, non-retryable diagnostic instead of an SDK connection error.
  return new Response(
    JSON.stringify({
      error: {
        message: `OhMyGame: ${error instanceof Error ? error.message : String(error)}`,
        type: "invalid_request_error",
        code: "ohmygame_deepseek_image_transport",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

async function fileRequest(
  delegate: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await delegate(url, init);
  } catch (error) {
    if (init.signal?.aborted && init.signal.reason?.name !== "TimeoutError")
      throw error;
    throw new FilesUnavailableError(
      `DeepSeek ${operation} unavailable (transport failed or timed out).`,
      { cause: error },
    );
  }
}

function fileHttpError(response: Response, operation: string): Error {
  void response.body?.cancel().catch(() => {});
  const message = `DeepSeek ${operation} failed (HTTP ${response.status}); the original content was retained locally.`;
  return response.status >= 500 || [408, 429].includes(response.status)
    ? new FilesUnavailableError(message)
    : new Error(message);
}

async function fileMetadata(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("DeepSeek returned invalid image file metadata.", {
        cause: error,
      });
    throw new FilesUnavailableError(
      "DeepSeek file metadata could not be received.",
      { cause: error },
    );
  }
}

async function rejectedFiles(
  response: Response,
  used: UsedFile[],
): Promise<UsedFile[]> {
  if (!used.length || ![400, 404, 410, 422].includes(response.status))
    return [];
  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return [];
  }
  if (!object(parsed) || !object(parsed.error)) return [];
  const detail = [parsed.error.code, parsed.error.type, parsed.error.message]
    .filter((value) => typeof value === "string")
    .join(" ");
  const ids = new Set(detail.match(/file-api-[a-zA-Z0-9_-]+/g) ?? []);
  const classification = detail.replace(/file-api-[a-zA-Z0-9_-]+/g, "file_id");
  const file = /\bfile(?:[_ -]?(?:id|not[_ -]?found|deleted|expired))?\b/i.test(
    classification,
  );
  const missing =
    /expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account/i.test(
      classification,
    );
  const invalid =
    /invalid[_ -]file[_ -]id|file[_ -]id[_ -]invalid|invalid (?:file_id|file id)\b|(?:file_id|file id)(?: is)? invalid\b/i.test(
      classification,
    );
  if (!file || (!missing && !invalid)) return [];
  return ids.size ? used.filter(({ id }) => ids.has(id)) : used;
}

async function readCache(cachePath: string): Promise<CachedFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    return validFile(parsed) ? parsed : undefined;
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw error;
    return undefined;
  }
}

/** Serialize generation checks with writes, so stale failures cannot invalidate a newer upload. */
async function updateCache(
  cachePath: string,
  update: (current: CachedFile | undefined) => CachedFile | undefined,
): Promise<void> {
  const previous = cacheUpdates.get(cachePath) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const file = update(await readCache(cachePath));
      if (!file) return;
      await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
        await rename(temporaryPath, cachePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  cacheUpdates.set(cachePath, operation);
  try {
    await operation;
  } finally {
    if (cacheUpdates.get(cachePath) === operation)
      cacheUpdates.delete(cachePath);
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
