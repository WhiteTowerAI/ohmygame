import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, Model, Api, TranscriptContext, Message } from "@earendil-works/pi-ai";
import { defineTool, type SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isDeepSeekFileModel } from "./deepseek-image-files.js";
import { PNG_SIGNATURE } from "./image-format.js";

export const IMAGE_OFFLOAD_ENTRY = "ohmygame-image-offload-v1";
export const INLINE_IMAGE_HIGH_BYTES = 20 * 1024 * 1024;
export const INLINE_IMAGE_LOW_BYTES = 10 * 1024 * 1024;
export const INLINE_IMAGE_HIGH_COUNT = 64;
export const INLINE_IMAGE_LOW_COUNT = 32;
export const MODEL_REQUEST_HIGH_BYTES = 32 * 1024 * 1024;
export type Json = Record<string, unknown>;
export const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

interface ImageOccurrence {
  image: ImageContent;
  game: boolean;
  protected: boolean;
}
interface OffloadData { scope: string; images: string[] }

export class ImageBudgetError extends Error {
  readonly status = 413;
  readonly code = "request_size_exceeded";
  constructor() {
    super("The model request exceeds the local image/history budget. Original images remain in the session. Reduce the current images or compact the text history before retrying.");
  }
}

export function localImageError(error: ImageBudgetError): Response {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: error.code, message: error.message } }),
  { status: error.status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
}

/** Only known image blocks are traversed; unrelated text, URLs and file references are untouched. */
export interface WireImage {
  data: string;
  mime: string;
  id?: string;
  omit(): void;
  file?: (id: string) => void;
}
const omittedIds = (text: string) => [...text.matchAll(/\[Image omitted from model context\. Session image: ([a-zA-Z0-9_-]+:\d+)/g)].map((match) => match[1]);
const markerIds = (text: string) => {
  const omitted = new Set(omittedIds(text));
  return [...text.matchAll(/^Session image: ([a-zA-Z0-9_-]+:\d+)/gm)].map((match) => match[1]).filter((id) => !omitted.has(id));
};
const googleOutput = (response: Json) => object(response.response)
  ? String(response.response.output ?? response.response.error ?? "") : "";
export function wireImages(payload: unknown): WireImage[] {
  const images: WireImage[] = [];
  const visit = (value: unknown, inheritedIds: string[] = [], googleResponse?: Json) => {
    if (Array.isArray(value)) {
      let ids = [...inheritedIds];
      let deferred: string[] = [];
      for (const item of value) {
        if (object(item)) {
          // Completions and Gemini < 3 put tool text before a separate user image turn.
          const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
          const head = parts[0];
          if (item.role === "user" && object(head) && ["Attached image(s) from tool result:", "Tool result image:"].includes(String(head.text))) {
            visit(parts, deferred); deferred = []; continue;
          }
          if (item.role === "tool" && typeof item.content === "string") deferred.push(...markerIds(item.content));
          else {
            const toolParts = parts.filter((part) => object(part) && object(part.functionResponse) && !Array.isArray(part.functionResponse.parts));
            if (toolParts.length) for (const part of toolParts) deferred.push(...markerIds(googleOutput((part as Json).functionResponse as Json)));
            else if (item.role && !(item.role === "assistant" && item.content === "I have processed the tool results.")) deferred = [];
          }
          if (typeof item.text === "string") {
            const markers = markerIds(item.text);
            if (markers.length) ids = markers;
            for (const omitted of omittedIds(item.text)) {
              const index = ids.indexOf(omitted); if (index >= 0) ids.splice(0, index + 1);
            }
          }
        }
        visit(item, ids, googleResponse);
      }
      return;
    }
    if (!object(value) || ArrayBuffer.isView(value)) return;
    if (object(value.functionResponse)) {
      const response = value.functionResponse;
      if (Array.isArray(response.parts)) visit(response.parts, markerIds(googleOutput(response)), response);
      return;
    }
    let data: string | undefined;
    let mime: string | undefined;
    let kind: "responses" | "completions" | "anthropic" | "google" | "bedrock" | undefined;
    const url = value.type === "input_image" ? value.image_url
      : value.type === "image_url" && object(value.image_url) ? value.image_url.url : undefined;
    if (typeof url === "string") {
      const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
      if (match) { mime = match[1]; data = match[2]; kind = value.type === "input_image" ? "responses" : "completions"; }
    } else if (value.type === "image" && object(value.source) && value.source.type === "base64"
      && typeof value.source.data === "string" && typeof value.source.media_type === "string") {
      data = value.source.data; mime = value.source.media_type; kind = "anthropic";
    } else {
      const inline = value.inlineData ?? value.inline_data;
      if (object(inline) && typeof inline.data === "string" && typeof (inline.mimeType ?? inline.mime_type) === "string") {
        data = inline.data; mime = String(inline.mimeType ?? inline.mime_type); kind = "google";
      } else if (object(value.image) && object(value.image.source) && value.image.source.bytes instanceof Uint8Array
        && typeof value.image.format === "string" && /^(jpeg|png|gif|webp)$/.test(value.image.format)) {
        data = Buffer.from(value.image.source.bytes).toString("base64"); mime = `image/${value.image.format}`; kind = "bedrock";
      }
    }
    if (data !== undefined && mime?.startsWith("image/") && kind) {
      const format = kind;
      const id = inheritedIds.shift();
      const replaceBlock = (block: Json) => {
        for (const key of Object.keys(value)) delete value[key];
        Object.assign(value, block);
      };
      images.push({ data, mime, id,
        omit: () => {
          if (format === "google" && googleResponse && Array.isArray(googleResponse.parts) && object(googleResponse.response)) {
            // FunctionResponse.parts accepts image/file data only; placeholders belong in its output.
            const parts = googleResponse.parts; const index = parts.indexOf(value);
            if (index >= 0) parts.splice(index, 1);
            if (!parts.length) delete googleResponse.parts;
            const key = typeof googleResponse.response.error === "string" ? "error" : "output";
            googleResponse.response[key] = `${googleOutput(googleResponse)}\n${omittedText(id)}`;
          } else replaceBlock(format === "google" || format === "bedrock" ? { text: omittedText(id) }
            : { type: format === "responses" ? "input_text" : "text", text: omittedText(id) });
        },
        file: format === "responses" ? (fileId) => { delete value.image_url; value.file_id = fileId; } : undefined,
      });
      return;
    }
    if (value.type === "input_image" && (typeof value.file_id === "string" || typeof value.image_url === "string")
      || value.type === "image_url" && object(value.image_url) && typeof value.image_url.url === "string") inheritedIds.shift();
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return images;
}

const imageText = (id: string) => `Session image: ${id}. Use recall_image with this imageId to inspect the original again.`;
const omittedText = (id?: string) => id ? `[Image omitted from model context. ${imageText(id)}]` : "[Image omitted from model context.]";
const imageBlocks = (content: unknown): ImageContent[] => Array.isArray(content)
  ? content.filter((block): block is ImageContent => object(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") : [];
const messageKey = (message: { role: string; timestamp: number; toolCallId?: string }) =>
  JSON.stringify([message.role === "custom" ? "user" : message.role, message.timestamp, message.toolCallId]);

/** Session originals and branch-local decisions are authoritative; the preview cache is disposable. */
export class SessionImages {
  private occurrences = new Map<string, ImageOccurrence>();
  constructor(private readonly manager: SessionManager, private readonly cacheDir: string) {}

  readonly recallTool = defineTool({
    name: "recall_image", label: "Recall Image",
    description: "Read an original image retained in this conversation, including screenshots omitted from model context. Use the imageId shown in its placeholder.",
    parameters: Type.Object({ imageId: Type.String({ pattern: "^[a-zA-Z0-9_-]+:[0-9]+$" }) }),
    execute: async (_callId, { imageId }) => {
      const [entryId, index] = imageId.split(":");
      const entry = this.manager.getBranch().find((item) => item.id === entryId);
      const content = entry?.type === "message" && "content" in entry.message ? entry.message.content
        : entry?.type === "custom_message" ? entry.content : undefined;
      const image = imageBlocks(content)[Number(index)];
      if (!image) throw new Error("The image is not available on this conversation branch.");
      return { content: [{ type: "text" as const, text: `Original ${imageText(imageId)}` }, { ...image }], details: undefined };
    },
  });

  async prepare(context: TranscriptContext, model: Model<Api>, resizeReadImages = true): Promise<TranscriptContext> {
    if (isDeepSeekFileModel(model)) return context;
    const sources = new Map<string, Array<{ id: string; images: ImageContent[] }>>();
    for (const entry of this.manager.getBranch()) {
      const message = entry.type === "message" && "content" in entry.message ? entry.message
        : entry.type === "custom_message" ? { role: "user", timestamp: Date.parse(entry.timestamp), content: entry.content } : undefined;
      if (!message) continue;
      const images = imageBlocks(message.content);
      if (!images.length) continue;
      const key = messageKey(message);
      const bucket = sources.get(key) ?? [];
      bucket.push({ id: entry.id, images }); sources.set(key, bucket);
    }
    const used = new Set<string>();
    const messages: Message[] = [];
    const occurrences = new Map<string, ImageOccurrence>();
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    const recentImages = context.messages.map((message, index) => message.role === "toolResult" && imageBlocks(message.content).length ? index : -1)
      .filter((index) => index >= 0).slice(-2);
    for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
      const message = context.messages[messageIndex];
      if (message.role === "system" || message.role === "assistant" || !Array.isArray(message.content)) { messages.push(message); continue; }
      const images = imageBlocks(message.content);
      if (!images.length) { messages.push(message); continue; }
      const source = sources.get(messageKey(message))?.find(({ id, images: original }) => !used.has(id)
        && original.length === images.length
        && original.every((image, index) => image.data === images[index].data && image.mimeType === images[index].mimeType));
      if (source) used.add(source.id);
      let index = 0;
      let convertedRead = false;
      const content = [];
      for (const block of message.content) {
        if (block.type !== "image") { content.push(block); continue; }
        const id = source ? `${source.id}:${index}` : undefined;
        index++;
        const game = message.role === "toolResult" && message.toolName === "game_use";
        const read = message.role === "toolResult" && message.toolName === "read" && resizeReadImages;
        const image = game || read ? await this.preview(block, game) : block;
        if (read && image.mimeType !== block.mimeType) convertedRead = true;
        if (id) {
          occurrences.set(id, { image, game, protected: messageIndex === lastUser || recentImages.includes(messageIndex) });
          content.push({ type: "text" as const, text: imageText(id) });
        }
        content.push(image);
      }
      messages.push({ ...message, content: convertedRead ? content.map((block) => block.type === "text"
        ? { ...block, text: block.text.replace("Read image file [image/png]", "Read image file [image/jpeg]") } : block) : content } as Message);
    }
    this.occurrences = occurrences;
    return { ...context, messages };
  }

  applyOmissions(payload: unknown, scope: string): WireImage[] {
    const omitted = this.omitted(scope);
    return wireImages(payload).filter((image) => {
      if (image.id && omitted.has(image.id)) { image.omit(); return false; }
      return true;
    });
  }

  /** The caller has already applied Files conversion or extracted the actual WS delta. */
  budget(payload: unknown, scope: string, force = false): boolean {
    const images = this.applyOmissions(payload, scope);
    // SDKs such as Bedrock serialize binary blobs as Base64, not numeric object keys.
    const requestBytes = () => Buffer.byteLength(JSON.stringify(payload,
      (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value));
    let bytes = images.reduce((total, image) => total + Buffer.byteLength(image.data), 0);
    let count = images.length;
    if (!force && bytes <= INLINE_IMAGE_HIGH_BYTES && count <= INLINE_IMAGE_HIGH_COUNT
      && requestBytes() <= MODEL_REQUEST_HIGH_BYTES) return false;
    const selected: string[] = [];
    const candidates = images.flatMap((image) => {
      const occurrence = image.id ? this.occurrences.get(image.id) : undefined;
      return occurrence && occurrence.image.data === image.data && occurrence.image.mimeType === image.mime && !occurrence.protected
        ? [{ image, game: occurrence.game }] : [];
    }).sort((a, b) => Number(!a.game) - Number(!b.game));
    for (const { image } of candidates) {
      if ((!force || selected.length > 0) && bytes <= INLINE_IMAGE_LOW_BYTES && count <= INLINE_IMAGE_LOW_COUNT
        && requestBytes() <= MODEL_REQUEST_HIGH_BYTES) break;
      image.omit(); selected.push(image.id!); bytes -= Buffer.byteLength(image.data); count--;
    }
    if (bytes > INLINE_IMAGE_HIGH_BYTES || count > INLINE_IMAGE_HIGH_COUNT
      || requestBytes() > MODEL_REQUEST_HIGH_BYTES || force && !selected.length) throw new ImageBudgetError();
    if (selected.length) this.manager.appendCustomEntry(IMAGE_OFFLOAD_ENTRY, { scope, images: selected } satisfies OffloadData);
    return selected.length > 0;
  }

  private omitted(scope: string): Set<string> {
    return new Set(this.manager.getBranch().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== IMAGE_OFFLOAD_ENTRY || !object(entry.data) || entry.data.scope !== scope || !Array.isArray(entry.data.images)) return [];
      return entry.data.images.filter((id): id is string => typeof id === "string");
    }));
  }

  private async preview(image: ImageContent, game: boolean): Promise<ImageContent> {
    if (image.mimeType !== "image/png" || image.data.length <= 256 * 1024) return image;
    const original = Buffer.from(image.data, "base64");
    // Read sprites may rely on transparency. Captures are opaque page observations.
    if (!game && !isOpaquePng(original)) return image;
    const hash = createHash("sha256").update("photon-jpeg-q80-v1:").update(image.data).digest("hex");
    const file = path.join(this.cacheDir, `${hash}.jpg`);
    let bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (!bytes) {
      const { PhotonImage } = await import("@silvia-odwyer/photon-node");
      let decoded: InstanceType<typeof PhotonImage> | undefined;
      try {
        decoded = PhotonImage.new_from_byteslice(original);
        bytes = Buffer.from(decoded.get_bytes_jpeg(80));
      } catch { return image; }
      finally { decoded?.free(); }
      if (bytes.length >= original.length) return image;
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
    }
    return { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64") };
  }
}

/** PNG alpha channels and palette transparency must survive read previews. */
function isOpaquePng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  if (![0, 2, 3].includes(bytes[25])) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + bytes.readUInt32BE(offset) + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") return false;
    if (type === "IDAT") return true;
    offset = end;
  }
  return false;
}
