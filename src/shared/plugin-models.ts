// A plugin's use of the language models the person set up in OhMyGame
// (`capabilities.models`, API 2.35.0): one request, one answer, nothing kept.
// A page asks with `host.models`, native code with `context.models`; both
// reach `src/daemon/plugin-models.ts`, which checks a request with
// `readPluginModelRequest` whichever way it came.

/** A model a plugin may ask, as `models.list` describes it. */
export interface PluginModelInfo {
  provider: string;
  id: string;
  name: string;
  /** Whether it reads images as well as text. */
  images: boolean;
  /** The one a request without `model` uses: the project's default, or the app's. */
  default?: true;
}

/** An image in a request: base64 data and its media type. */
export interface PluginModelImage {
  data: string;
  type: string;
}

export interface PluginModelMessage {
  role: "user" | "assistant";
  text: string;
  /** Only in a user's message, and only for a model that reads images. */
  images?: PluginModelImage[];
}

export interface PluginModelRequest {
  /** What the model is told about its job, before the messages. */
  system?: string;
  messages: PluginModelMessage[];
  /** Asks for JSON and reads the answer as JSON, which fails if it isn't. */
  json?: boolean;
  /** The most the model writes; 2,048 when left out. */
  maxTokens?: number;
  /** One of `models.list`; the default model when left out. */
  model?: { provider: string; id: string };
}

export interface PluginModelResult {
  text: string;
  /** The answer read as JSON, with `json`. */
  json?: unknown;
  model: { provider: string; id: string };
  /** Tokens read and written, which count toward the person's use of the provider. */
  usage: { input: number; output: number };
  /** `length` when the answer stopped at `maxTokens`. */
  stopReason: "stop" | "length";
}

export const PLUGIN_MODEL_LIMITS = {
  systemChars: 20_000,
  messages: 40,
  /** All the text of a request together, the system's included. */
  textChars: 200_000,
  images: 8,
  /** Each image, as base64. */
  imageChars: 7_000_000,
  maxTokens: 8_192,
  defaultMaxTokens: 2_048,
  /** How many requests of one plugin run at once, and in a minute. */
  concurrent: 3,
  perMinute: 30,
  timeoutMs: 120_000,
} as const;

/** The most one image may be before it is base64, which grows it by a third. */
export const PLUGIN_MODEL_IMAGE_MAX_BYTES = Math.floor(PLUGIN_MODEL_LIMITS.imageChars / 4) * 3;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;

/** Checks a request from a plugin, returning it or why it is refused. */
export function readPluginModelRequest(value: unknown): { ok: true; request: PluginModelRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("A model request is an object");
  const { system, messages, json, maxTokens, model } = value as Record<string, unknown>;
  const limits = PLUGIN_MODEL_LIMITS;
  if (system !== undefined && (typeof system !== "string" || system.length > limits.systemChars))
    return fail(`system is text of at most ${limits.systemChars.toLocaleString("en")} characters`);
  if (!Array.isArray(messages) || !messages.length || messages.length > limits.messages)
    return fail(`messages is a list of 1 to ${limits.messages} messages`);
  let chars = typeof system === "string" ? system.length : 0;
  let images = 0;
  const read: PluginModelMessage[] = [];
  for (const [index, item] of messages.entries()) {
    const message = item as Record<string, unknown> | null;
    if (!message || typeof message !== "object") return fail(`messages[${index}] is an object`);
    if (message.role !== "user" && message.role !== "assistant") return fail(`messages[${index}].role is user or assistant`);
    if (typeof message.text !== "string") return fail(`messages[${index}].text is text`);
    chars += message.text.length;
    const entry: PluginModelMessage = { role: message.role, text: message.text };
    if (message.images !== undefined) {
      if (message.role !== "user") return fail(`messages[${index}] is the assistant's, which has no images`);
      if (!Array.isArray(message.images)) return fail(`messages[${index}].images is a list`);
      entry.images = [];
      for (const image of message.images as unknown[]) {
        const { data, type } = (image ?? {}) as Record<string, unknown>;
        if (typeof type !== "string" || !IMAGE_TYPES.has(type)) return fail("an image's type is image/png, image/jpeg, image/webp or image/gif");
        if (typeof data !== "string" || !data.length || data.length > limits.imageChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
          return fail(`an image's data is base64 of at most ${limits.imageChars.toLocaleString("en")} characters`);
        entry.images.push({ data, type });
        images++;
      }
    }
    if (!entry.text.trim() && !entry.images?.length) return fail(`messages[${index}] has no text or images`);
    read.push(entry);
  }
  if (chars > limits.textChars) return fail(`a request's text is at most ${limits.textChars.toLocaleString("en")} characters`);
  if (images > limits.images) return fail(`a request has at most ${limits.images} images`);
  if (read.at(-1)!.role !== "user") return fail("the last message is the user's");
  if (json !== undefined && typeof json !== "boolean") return fail("json is true or false");
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > limits.maxTokens))
    return fail(`maxTokens is a whole number from 1 to ${limits.maxTokens.toLocaleString("en")}`);
  let chosen: PluginModelRequest["model"];
  if (model !== undefined) {
    const { provider, id } = (model ?? {}) as Record<string, unknown>;
    if (typeof provider !== "string" || !NAME.test(provider) || typeof id !== "string" || !NAME.test(id))
      return fail("model is { provider, id }, one of models.list");
    chosen = { provider, id };
  }
  return {
    ok: true,
    request: {
      ...(typeof system === "string" && system ? { system } : {}),
      messages: read,
      ...(json ? { json: true } : {}),
      ...(maxTokens !== undefined ? { maxTokens: maxTokens as number } : {}),
      ...(chosen ? { model: chosen } : {}),
    },
  };
}
