import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ImageModel, PromptImage } from "../shared/contracts.js";
import { networkCovers, PLUGIN_MEDIA_ADAPTER_MAX_BYTES } from "../shared/plugin-manifest.js";
import { sniffImageType } from "./image-format.js";
import { ImageGenerationError, type GeneratedImage, type ImageGenerationInput } from "./openai-image.js";
import { localizePluginString, type PluginIndexEntry } from "./plugin-index.js";
import { runMediaAdapter, type MediaFetchRequest, type MediaFetchResponse } from "./plugin-media-sandbox.js";
import { pluginModelProviderId } from "./plugin-model-providers.js";
import type { PluginServices } from "./plugin-services.js";

// What installed plugins' model providers make besides chat
// (docs/media-provider-plugins.md). Each provider's media models join the
// app's catalogs under the provider's id while its key is set; a request
// runs the plugin's adapter in the sandbox, which reaches the vendor only
// through `fetch` here, to the hosts the person approved, with the key added
// where the adapter asks.

type ManifestProvider = NonNullable<NonNullable<PluginIndexEntry["manifest"]["contributes"]>["providers"]>[number];
type MediaSection = NonNullable<ManifestProvider["media"]>;
type MediaAuth = NonNullable<MediaSection["auth"]>;

const DEFAULT_AUTH: MediaAuth = { header: "authorization", scheme: "Bearer" };
/** One answer `host.fetch` gives, and one file the app downloads. */
const RESPONSE_MAX_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const ANSWER_HEADERS = ["content-type", "content-length", "retry-after", "location", "x-request-id"];
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
/** A task the adapter keeps between checks. */
const TASK_MAX_CHARACTERS = 16 * 1024;
/** How long an image may take, checks included. */
const IMAGE_LIMIT_MS = 10 * 60_000;

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

export class PluginMediaProviders {
  readonly #sources = new Map<string, Promise<string>>();

  constructor(
    private readonly services: PluginServices,
    private readonly request: typeof fetch = fetch,
    private readonly log: (pluginId: string, message: string) => void = () => {},
  ) {}

  /** Installed providers with media whose key is set, or that need none. */
  async providers(): Promise<PluginMediaProvider[]> {
    const providers: PluginMediaProvider[] = [];
    for (const entry of await this.services.installed()) {
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
      const name = localizePluginString(item.entry, item.provider.title, "en");
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

  /** Makes one picture with a provider's adapter. */
  async generateImage(model: ImageModel, input: Omit<ImageGenerationInput, "imageModel">, signal?: AbortSignal): Promise<GeneratedImage> {
    const item = (await this.providers()).find((candidate) => candidate.id === model.provider);
    if (!item?.media.image) throw new ImageGenerationError("The selected image provider is unavailable. Check its plugin and key.", 503);
    const outputs = await this.#run(item, "image", {
      model: model.id,
      prompt: input.prompt,
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.transparentBackground ? { transparentBackground: true } : {}),
      references: (input.images ?? []).map((image: PromptImage) => ({ mediaType: image.mediaType, base64: image.data })),
    }, IMAGE_LIMIT_MS, signal);
    const bytes = await this.#output(item, outputs[0]!, signal);
    const mediaType = sniffImageType(bytes);
    if (!mediaType) throw new ImageGenerationError(`${this.#name(item)} returned a file that isn't a PNG, JPEG or WebP picture`);
    return { bytes, mediaType };
  }

  /** Runs `start`, then `check` while the vendor works, until there are outputs. */
  async #run(item: PluginMediaProvider, kind: string, input: unknown, limitMs: number, signal?: AbortSignal): Promise<Output[]> {
    const source = await this.#source(item);
    const call = (step: string, args: unknown[]) => runMediaAdapter({
      source, file: item.media.adapter, kind, step, args,
      fetch: (request, stepSignal) => this.#fetch(item, request, stepSignal),
      log: (message) => this.log(item.entry.id, message),
      ...(signal ? { signal } : {}),
    }).catch((cause: unknown) => {
      throw new ImageGenerationError(`${this.#name(item)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    const deadline = Date.now() + limitMs;
    let answer = answerOf(await call("start", [input]), undefined);
    let wait = 2;
    while ("task" in answer) {
      const task = answer.task;
      // The adapter's pace, kept between 1 s and a minute; without one, 2 s growing to 15 s.
      const seconds = answer.retryAfter !== undefined ? Math.min(60, Math.max(1, answer.retryAfter)) : wait;
      wait = Math.min(15, wait * 1.5);
      try {
        if (Date.now() + seconds * 1000 > deadline) throw new ImageGenerationError(`${this.#name(item)} took longer than ${Math.round(limitMs / 60_000)} minutes`, 504);
        await delay(seconds * 1000, signal);
      } catch (cause) {
        // Stopped by the person or out of time: tell the vendor, if the adapter can.
        void call("cancel", [task]).catch(() => {});
        throw cause;
      }
      answer = answerOf(await call("check", [task]), task);
    }
    if ("error" in answer) throw new ImageGenerationError(`${this.#name(item)}: ${answer.error}`);
    return answer.outputs;
  }

  /** The adapter's source, read once per package. */
  #source(item: PluginMediaProvider): Promise<string> {
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
      })().catch((cause: unknown) => {
        this.#sources.delete(key);
        throw new ImageGenerationError(`${this.#name(item)}: ${cause instanceof Error ? cause.message : String(cause)}`, 503);
      });
      this.#sources.set(key, source);
    }
    return source;
  }

  /** `host.fetch`: HTTPS to the plugin's approved hosts, with the key added when asked. */
  async #fetch(item: PluginMediaProvider, request: MediaFetchRequest, signal: AbortSignal): Promise<MediaFetchResponse> {
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
    if (request.auth === true) {
      const key = item.provider.apiKey ? this.services.values.secret(item.entry, item.provider.apiKey) : undefined;
      if (key === undefined) throw new Error("the provider has no key to send");
      const auth = item.media.auth ?? DEFAULT_AUTH;
      if ("query" in auth) url.searchParams.set(auth.query, key);
      else headers.set(auth.header, auth.scheme ? `${auth.scheme} ${key}` : key);
    }
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
    const answer: Record<string, string> = {};
    for (const name of ANSWER_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) answer[name] = value;
    }
    return { status: response.status, headers: answer, body: (await readCapped(response, url.host)).toString("utf8") };
  }

  /** Downloads or decodes one output. */
  async #output(item: PluginMediaProvider, output: Output, signal?: AbortSignal): Promise<Buffer> {
    if ("base64" in output) {
      const bytes = Buffer.from(output.base64, "base64");
      if (!bytes.length || bytes.length > RESPONSE_MAX_BYTES) throw new ImageGenerationError(`${this.#name(item)} returned an empty or oversized file`);
      return bytes;
    }
    const url = this.#allowed(item, output.url, ImageGenerationError);
    const response = await this.request(url, {
      redirect: "manual", credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ImageGenerationError(`${this.#name(item)}'s result at ${url.host} could not be downloaded`); });
    if (!response.ok) throw new ImageGenerationError(`${this.#name(item)}'s result at ${url.host} answered ${response.status}`);
    return readCapped(response, url.host);
  }

  /** An HTTPS address on a host the plugin's `capabilities.network` lists. */
  #allowed(item: PluginMediaProvider, value: unknown, Failure: new (message: string) => Error = Error): URL {
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
function answerOf(value: unknown, task: unknown): Answer {
  const fail = (why: string): never => { throw new ImageGenerationError(`The plugin's adapter ${why}`); };
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

async function readCapped(response: Response, host: string): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > RESPONSE_MAX_BYTES) throw new Error(`${host} answered with more than 20 MB`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > RESPONSE_MAX_BYTES) throw new Error(`${host} answered with more than 20 MB`);
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
