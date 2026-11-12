import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ImageModel, PromptImage, VideoModel, VideoReferenceMode } from "../shared/contracts.js";
import { networkCovers, PLUGIN_MEDIA_ADAPTER_MAX_BYTES } from "../shared/plugin-manifest.js";
import { sniffImageType } from "./image-format.js";
import { GenerationShutdown, MediaTaskBusyError, type MediaTaskJournal, type MediaTaskStart } from "./media-task-journal.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput } from "./openai-image.js";
import { localizePluginString, type PluginIndexEntry } from "./plugin-index.js";
import { runMediaAdapter, type MediaFetchRequest, type MediaFetchResponse } from "./plugin-media-sandbox.js";
import { pluginModelProviderId } from "./plugin-model-providers.js";
import type { PluginServices } from "./plugin-services.js";
import { VideoGenerationError, type GeneratedVideo, type VideoGenerationInput } from "./video-generation.js";

// What installed plugins' model providers make besides chat
// (docs/media-provider-plugins.md). Each provider's media models join the
// app's catalogs under the provider's id while its key is set; a request
// runs the plugin's adapter in the sandbox, which reaches the vendor only
// through `fetch` here, to the hosts the person approved, with the key added
// where the adapter asks.

type ManifestProvider = NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number];
type MediaSection = NonNullable<ManifestProvider["media"]>;
type MediaAuth = NonNullable<MediaSection["auth"]>;
/** The error a kind's requests fail with, which carries an HTTP status. */
type Failure = new (message: string, statusCode?: number) => Error;

const DEFAULT_AUTH: MediaAuth = { header: "authorization", scheme: "Bearer" };
/** One answer `host.fetch` gives, and one picture the app downloads. */
const RESPONSE_MAX_BYTES = 20 * 1024 * 1024;
/** One video the app downloads. */
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
/** A video download, which may be large. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ANSWER_HEADERS = ["content-type", "content-length", "retry-after", "location", "x-request-id"];
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
/** A task the adapter keeps between checks. */
const TASK_MAX_CHARACTERS = 16 * 1024;
/** How long an image may take, checks included. */
const IMAGE_LIMIT_MS = 10 * 60_000;
/** How long a video may take, checks and the download included, as for built-in providers. */
const VIDEO_LIMIT_MS = 15 * 60_000;
/** How long telling the vendor to stop may take. */
const CANCEL_LIMIT_MS = 30_000;

export interface PluginMediaProvider {
  /** `plugin.<publisher>.<name>.<provider>`, as its chat is. */
  id: string;
  entry: PluginIndexEntry;
  provider: ManifestProvider;
  media: MediaSection;
}

/** What an adapter's step answered. */
type Answer =
  | { outputs: Output[] }
  | { error: string }
  | { task: unknown; retryAfter?: number };
type Output = { url: string } | { base64: string; mediaType?: string };

interface RunOptions {
  limitMs: number;
  signal?: AbortSignal | undefined;
  Failure: Failure;
  /** Where a task is kept so a retry after a restart resumes it. */
  journal?: MediaTaskJournal | undefined;
}

export class PluginMediaProviders {
  readonly #sources = new Map<string, Promise<string>>();

  constructor(
    private readonly services: PluginServices,
    private readonly request: typeof fetch = fetch,
    private readonly log: (pluginId: string, message: string) => void = () => {},
  ) {}

  /**
   * Installed providers with media whose key is set, or that need none, of
   * plugins the person has allowed everything they ask for, such as their hosts.
   */
  async providers(): Promise<PluginMediaProvider[]> {
    const providers: PluginMediaProvider[] = [];
    for (const entry of await this.services.everyProject()) {
      for (const provider of entry.manifest.contributes?.providers ?? []) {
        if (!provider.media) continue;
        if (provider.apiKey && this.services.values.secret(entry, provider.apiKey) === undefined) continue;
        providers.push({ id: pluginModelProviderId(entry.id, provider.id), entry, provider, media: provider.media });
      }
    }
    return providers;
  }

  /** The image models of each provider that makes images, as the image catalog lists them. */
  async imageProviders(): Promise<Array<{ id: string; name: string; models: ImageModel[] }>> {
    return (await this.providers()).filter((item) => item.media.image).map((item) => {
      const name = this.#name(item);
      return {
        id: item.id,
        name,
        models: item.media.image!.models.map((model): ImageModel => ({
          provider: item.id,
          providerName: name,
          id: model.id,
          name: model.title ? localizePluginString(item.entry, model.title, "en") : model.id,
          protocol: "plugin",
          sizes: [],
          generationOptions: model.resolutions.flatMap((resolution) => model.aspectRatios.map((aspectRatio) => ({ resolution, aspectRatio }))),
          supportsReferenceImage: (model.maxReferenceImages ?? 0) > 0,
          maxReferenceImages: model.maxReferenceImages ?? 0,
          maxOutputs: 1,
        })),
      };
    });
  }

  /** The video models of each provider that makes videos, as the video catalog lists them. */
  async videoProviders(): Promise<Array<{ id: string; name: string; models: VideoModel[] }>> {
    return (await this.providers()).filter((item) => item.media.video).map((item) => {
      const name = this.#name(item);
      return {
        id: item.id,
        name,
        models: item.media.video!.models.map((model): VideoModel => {
          const referenceModes: readonly VideoReferenceMode[] = model.referenceModes ?? ["frame"];
          return {
            provider: item.id,
            providerName: name,
            id: model.id,
            name: model.title ? localizePluginString(item.entry, model.title, "en") : model.id,
            durations: model.durations,
            resolutions: model.resolutions,
            aspectRatios: model.aspectRatios,
            maxImageReferences: model.maxReferenceImages ?? 0,
            imageReferenceMode: referenceModes[0]!,
            referenceModes,
          };
        }),
      };
    });
  }

  /** Makes one picture with a provider's adapter. */
  async generateImage(model: ImageModel, input: Omit<ImageGenerationInput, "imageModel">, signal?: AbortSignal): Promise<GeneratedImage> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    if (!item?.media.image) throw new ImageGenerationError("The selected image provider is unavailable. Check its plugin and key.", 503);
    return this.#produce(item, "image", {
      model: model.id,
      prompt: input.prompt,
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.transparentBackground ? { transparentBackground: true } : {}),
      references: (input.images ?? []).map((image: PromptImage) => ({ mediaType: image.mediaType, base64: image.data })),
    }, { limitMs: IMAGE_LIMIT_MS, signal, Failure: ImageGenerationError }, async (outputs, stopped) => {
      const bytes = await this.#output(item, outputs[0]!, RESPONSE_MAX_BYTES, REQUEST_TIMEOUT_MS, ImageGenerationError, stopped);
      const mediaType = sniffImageType(bytes);
      if (!mediaType) throw new ImageGenerationError(`${this.#name(item)} returned a file that isn't a PNG, JPEG or WebP picture`);
      return { bytes, mediaType };
    });
  }

  /**
   * Makes one video with a provider's adapter. With a journal, the vendor's
   * task is kept, so retrying after a restart checks it again.
   */
  async generateVideo(model: VideoModel, input: VideoGenerationInput, signal?: AbortSignal, journal?: MediaTaskJournal): Promise<GeneratedVideo> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    if (!item?.media.video) throw new VideoGenerationError("The selected video provider is unavailable. Check its plugin and key.", 503);
    const duration = input.duration ?? model.durations[0]!;
    const resolution = input.resolution ?? model.resolutions[0]!;
    const aspectRatio = input.aspectRatio ?? model.aspectRatios[0]!;
    if (!model.durations.includes(duration)) throw new VideoGenerationError("Video duration is not supported by the selected model", 400);
    if (!model.resolutions.includes(resolution)) throw new VideoGenerationError("Video resolution is not supported by the selected model", 400);
    if (!model.aspectRatios.includes(aspectRatio)) throw new VideoGenerationError("Video aspect ratio is not supported by the selected model", 400);
    const references = input.references ?? [];
    const referenceMode = input.referenceMode ?? model.imageReferenceMode ?? "frame";
    if (references.length && !(model.referenceModes ?? [referenceMode]).includes(referenceMode)) throw new VideoGenerationError("The selected video model does not support this reference mode", 400);
    if (references.some((reference) => reference.type !== "image")) throw new VideoGenerationError("Plugin video providers take image references only", 400);
    // As frames, two at most: the first and the last.
    const maxReferences = referenceMode === "frame" ? Math.min(2, model.maxImageReferences) : model.maxImageReferences;
    if (references.length > maxReferences) throw new VideoGenerationError(`The selected video model supports up to ${maxReferences} reference images`, 400);
    const pictures = await Promise.all(references.map(async (reference) => ({ mediaType: reference.mediaType, base64: (await readFile(reference.absolutePath)).toString("base64") })));
    return this.#produce(item, "video", {
      model: model.id,
      prompt: input.prompt,
      duration,
      resolution,
      aspectRatio,
      ...(pictures.length ? { referenceMode } : {}),
      references: pictures,
    }, { limitMs: VIDEO_LIMIT_MS, signal, Failure: VideoGenerationError, journal }, async (outputs, stopped) => {
      const bytes = await this.#output(item, outputs[0]!, VIDEO_MAX_BYTES, DOWNLOAD_TIMEOUT_MS, VideoGenerationError, stopped);
      if (bytes.length < 12 || bytes.subarray(4, 8).toString("latin1") !== "ftyp") throw new VideoGenerationError(`${this.#name(item)} returned a file that isn't an MP4 video`);
      return { bytes, mediaType: "video/mp4" };
    });
  }

  /**
   * Runs `start`, then `check` while the vendor works, until there are
   * outputs, and `finish` on them, all within the kind's time limit.
   */
  async #produce<T>(item: PluginMediaProvider, kind: string, input: unknown, options: RunOptions, finish: (outputs: Output[], stopped: AbortSignal) => Promise<T>): Promise<T> {
    const { limitMs, signal, Failure, journal } = options;
    const name = this.#name(item);
    const source = await this.#source(item, Failure);
    const outOfTime = new Failure(`${name} took longer than ${Math.round(limitMs / 60_000)} minutes`, 504);
    const deadline = AbortSignal.timeout(limitMs);
    const stopped = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Out of time reads as such; stopped by the person or the app, as they stopped it.
    const why = (aborted: AbortSignal) => deadline.aborted && aborted.reason === deadline.reason ? outOfTime : aborted.reason as unknown;
    // Requests `start` sent that have no answer yet: one lost may have started a task.
    let unanswered = 0;
    const call = (step: string, args: unknown[], stepSignal: AbortSignal) => runMediaAdapter({
      source, file: item.media.adapter, kind, step, args,
      fetch: (request, fetchSignal) => this.#fetch(item, request, fetchSignal, step === "start" ? (change) => { unanswered += change; } : undefined),
      log: (message) => this.log(item.entry.id, message),
      signal: stepSignal,
    }).catch((cause: unknown) => {
      if (stepSignal.aborted) throw why(stepSignal);
      throw new Failure(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });

    let begun: MediaTaskStart = { state: "new" };
    if (journal) {
      try {
        begun = await journal.begin({ plugin: item.entry.id, provider: item.provider.id, kind, input });
      } catch (cause) {
        journal.release();
        throw cause instanceof MediaTaskBusyError ? new Failure(cause.message, 409) : cause;
      }
      if (begun.state === "changed" || begun.state === "unconfirmed") {
        journal.release();
        throw new Failure(begun.state === "changed"
          ? `${name}: the provider or the request changed since this ${kind} started. Restore them to resume, or start a new generation.`
          : `${name} may have started this ${kind} already, but its answer was lost. Check ${name}'s own site before starting a new one; retrying won't start another.`, 409);
      }
    }
    let task = begun.state === "resume" ? begun.task : undefined;
    let saved = task === undefined ? undefined : JSON.stringify(task);
    // Whether the vendor answered for good; until then, a failure leaves its task running.
    let settled = false;
    // Whether the journal keeps the request after this run, for a retry to resume.
    let keep = false;
    try {
      let answer: Answer;
      if (begun.state === "resume") answer = { task, retryAfter: 1 };
      else {
        try {
          answer = answerOf(await call("start", [input], stopped), undefined, Failure);
        } catch (cause) {
          // Never send a start again that may have reached the vendor.
          if (unanswered > 0) keep = true;
          throw cause;
        }
      }
      let wait = 2;
      while ("task" in answer) {
        task = answer.task;
        const text = JSON.stringify(task);
        if (journal && text !== saved) {
          await journal.save(task);
          saved = text;
        }
        // The adapter's pace, kept between 1 s and a minute; without one, 2 s growing to 15 s.
        const seconds = answer.retryAfter !== undefined ? Math.min(60, Math.max(1, answer.retryAfter)) : wait;
        wait = Math.min(15, wait * 1.5);
        await delay(seconds * 1000, stopped).catch(() => { throw why(stopped); });
        answer = answerOf(await call("check", [task], stopped), task, Failure);
      }
      settled = true;
      if ("error" in answer) throw new Failure(`${name}: ${answer.error}`);
      return await finish(answer.outputs, stopped);
    } catch (cause) {
      if (signal?.aborted && signal.reason instanceof GenerationShutdown) {
        // The app is closing: keep the task for a retry to resume, and let the vendor go on.
        if (task !== undefined) keep = true;
      } else if (!settled && task !== undefined) {
        // Stopped, out of time, or a step failed while the vendor works: tell it, if the adapter can.
        void call("cancel", [task], AbortSignal.timeout(CANCEL_LIMIT_MS)).catch(() => {});
      }
      throw cause;
    } finally {
      if (journal) {
        if (!keep) await journal.clear().catch(() => {});
        journal.release();
      }
    }
  }

  /** The adapter's source, read once per package. */
  #source(item: PluginMediaProvider, Failure: Failure): Promise<string> {
    const key = `${item.entry.root}\0${item.entry.digest}\0${item.media.adapter}`;
    let source = this.#sources.get(key);
    if (!source) {
      source = (async () => {
        const root = await realpath(item.entry.root);
        const file = await realpath(path.resolve(root, item.media.adapter));
        if (!file.startsWith(root + path.sep)) throw new Error(`${item.media.adapter} is outside the package`);
        const bytes = await readFile(file);
        if (bytes.length > PLUGIN_MEDIA_ADAPTER_MAX_BYTES) throw new Error(`${item.media.adapter} is larger than 512 KB`);
        return bytes.toString("utf8");
      })();
      source.catch(() => this.#sources.delete(key));
      this.#sources.set(key, source);
    }
    return source.catch((cause: unknown) => {
      throw new Failure(`${this.#name(item)}: ${cause instanceof Error ? cause.message : String(cause)}`, 503);
    });
  }

  /**
   * `host.fetch`: HTTPS to the plugin's approved hosts, with the key added
   * when asked. `pending` hears of a request sent (+1) and answered (-1).
   */
  async #fetch(item: PluginMediaProvider, request: MediaFetchRequest, signal: AbortSignal, pending?: (change: number) => void): Promise<MediaFetchResponse> {
    const url = this.#allowed(item, request?.url);
    const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    if (!METHODS.has(method)) throw new Error(`host.fetch can't send ${method}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers && typeof request.headers === "object" ? request.headers : {}))
      if (typeof value === "string") headers.set(name, value);
    headers.delete("cookie");
    let body: string | undefined;
    if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      headers.set("content-type", "application/json");
    } else if (typeof request.body === "string") body = request.body;
    let key: string | undefined;
    if (request.auth === true) {
      key = item.provider.apiKey ? this.services.values.secret(item.entry, item.provider.apiKey) : undefined;
      if (!key) throw new Error("the provider has no key to send");
      const auth = item.media.auth ?? DEFAULT_AUTH;
      if ("query" in auth) url.searchParams.set(auth.query, key);
      else headers.set(auth.header, auth.scheme ? `${auth.scheme} ${key}` : key);
    }
    pending?.(1);
    const response = await this.request(url, {
      method,
      headers,
      ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    }).catch((cause: unknown) => {
      // Never the address: it may carry the key.
      throw new Error(`${url.host} could not be reached${cause instanceof Error && cause.name === "TimeoutError" ? " in time" : ""}`);
    });
    // An answer may echo the key, as a redirect to the same address would: the adapter never sees it.
    const json = key === undefined ? "" : JSON.stringify(key).slice(1, -1);
    const forms = key === undefined ? [] : [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2), json, json.replaceAll("/", "\\/")])];
    const hide = (text: string) => forms.reduce((hidden, form) => hidden.split(form).join("[key]"), text);
    // JSON can spell the key with escapes (`\u0073k-…`) that `json()` undoes: written out again, they read plainly.
    // That is done to the vendor's own text, before anything in it is replaced, and the
    // adapter then gets only that form, for text() as for json().
    const hideBody = (text: string) => {
      if (key !== undefined) {
        try {
          return hide(JSON.stringify(JSON.parse(text)));
        } catch { /* not JSON */ }
      }
      return hide(text);
    };
    const answer: Record<string, string> = {};
    for (const name of ANSWER_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) answer[name] = hide(value);
    }
    const text = (await readCapped(response, url.host, RESPONSE_MAX_BYTES)).toString("utf8");
    pending?.(-1);
    return { status: response.status, headers: answer, body: hideBody(text) };
  }

  /** Downloads or decodes one output. */
  async #output(item: PluginMediaProvider, output: Output, maxBytes: number, timeoutMs: number, Failure: Failure, signal: AbortSignal): Promise<Buffer> {
    if ("base64" in output) {
      const bytes = Buffer.from(output.base64, "base64");
      if (!bytes.length || bytes.length > maxBytes) throw new Failure(`${this.#name(item)} returned an empty or oversized file`);
      return bytes;
    }
    const url = this.#allowed(item, output.url, Failure);
    const response = await this.request(url, {
      redirect: "manual", credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    }).catch((cause: unknown) => {
      if (signal.aborted) throw signal.reason;
      throw new Failure(`${this.#name(item)}'s result at ${url.host} could not be downloaded${cause instanceof Error && cause.name === "TimeoutError" ? " in time" : ""}`);
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Failure(`${this.#name(item)}'s result at ${url.host} answered ${response.status}`);
    }
    return readCapped(response, url.host, maxBytes).catch((cause: unknown) => {
      if (signal.aborted) throw signal.reason;
      throw new Failure(`${this.#name(item)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  /** An HTTPS address on a host the plugin's `capabilities.network` lists. */
  #allowed(item: PluginMediaProvider, value: unknown, Failure: Failure = Error): URL {
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      throw new Failure("host.fetch needs an https address");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new Failure("host.fetch needs an https address without a user name");
    if (!networkCovers(item.entry.manifest.capabilities?.network, url)) throw new Failure(`${url.host} isn't in the plugin's capabilities.network`);
    return url;
  }

  #name(item: PluginMediaProvider): string {
    return localizePluginString(item.entry, item.provider.title, "en");
  }
}

/** Reads what a step returned; anything else is the adapter's mistake. */
function answerOf(value: unknown, task: unknown, Failure: Failure): Answer {
  const fail = (why: string): never => { throw new Failure(`The plugin's adapter ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("returned neither outputs, a task nor an error");
  const answer = value as Record<string, unknown>;
  if (typeof answer.error === "string") return { error: answer.error.slice(0, 1000) };
  if (Array.isArray(answer.outputs)) {
    const outputs = answer.outputs.filter((output): output is Output => Boolean(output) && typeof output === "object"
      && (typeof (output as { url?: unknown }).url === "string" || typeof (output as { base64?: unknown }).base64 === "string"));
    return outputs.length ? { outputs } : fail("returned no outputs");
  }
  const next = "task" in answer ? answer.task : task;
  if (next === undefined) return fail("returned neither outputs, a task nor an error");
  if (JSON.stringify(next).length > TASK_MAX_CHARACTERS) return fail("returned a task larger than 16 KB");
  return { task: next, ...(typeof answer.retryAfter === "number" && Number.isFinite(answer.retryAfter) ? { retryAfter: answer.retryAfter } : {}) };
}

/** Reads an answer up to `maxBytes`, letting go of the rest of a larger one. */
async function readCapped(response: Response, host: string, maxBytes: number): Promise<Buffer> {
  const tooLarge = `${host} answered with more than ${Math.round(maxBytes / 1024 / 1024)} MB`;
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(tooLarge);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    // Leaving the loop early cancels the body.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error(tooLarge);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
