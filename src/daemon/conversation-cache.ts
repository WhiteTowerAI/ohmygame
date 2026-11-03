import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager, type FileEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { PromptImage, ProjectState } from "../shared/contracts.js";
import type { ConversationImageStore } from "./conversation-images.js";
import { boundToolOutput, MAX_TOOL_OUTPUT } from "./tool-output.js";

interface CachedSession {
  signature: string;
  inode: number;
  size: number;
  offset: number;
  /** The file's first and last bytes as read, to tell an append from a rewrite without reading it all again. */
  sample: string;
  appendable: boolean;
  entries: FileEntry[];
  manager: SessionManager;
}

export type ConversationInfo = Pick<SessionInfo, "path" | "id" | "name" | "created" | "modified" | "messageCount" | "firstMessage">;

/** Read-only UI view without images and long tool output. Never pass these managers to an agent. */
export class ConversationCache {
  readonly #cache = new Map<string, CachedSession>();
  readonly #loading = new Map<string, Promise<SessionManager | undefined>>();
  readonly #metadata = new Map<string, { signature: string; info: ConversationInfo }>();

  constructor(private readonly images?: ConversationImageStore) {}

  async info(project: ProjectState, file: string): Promise<ConversationInfo | undefined> {
    const stats = await stat(file).catch(() => undefined);
    if (!stats) { this.#metadata.delete(file); this.#cache.delete(file); return undefined; }
    const signature = fileSignature(stats);
    const cached = this.#metadata.get(file);
    if (cached?.signature === signature) return cached.info;
    const manager = await this.read(project, file);
    if (!manager) return undefined;
    const info = sessionInfo(manager, file, stats.mtime);
    // Cache the signature of the bytes actually read, not a newer append.
    this.#metadata.set(file, { signature: this.#cache.get(file)?.signature ?? signature, info });
    return info;
  }

  forgetDirectory(directory: string): void {
    for (const file of this.#cache.keys()) if (file.startsWith(`${directory}/`)) this.#cache.delete(file);
    for (const file of this.#metadata.keys()) if (file.startsWith(`${directory}/`)) this.#metadata.delete(file);
  }

  read(project: ProjectState, file: string): Promise<SessionManager | undefined> {
    // A reader that starts after a turn closes must validate the file again:
    // an earlier read may have checked it just before the final append.
    const read = () => this.#read(project, file);
    const promise = (this.#loading.get(file) ?? Promise.resolve()).then(read, read);
    this.#loading.set(file, promise);
    const settled = () => { if (this.#loading.get(file) === promise) this.#loading.delete(file); };
    void promise.then(settled, settled);
    return promise;
  }

  async #read(project: ProjectState, file: string): Promise<SessionManager | undefined> {
    const stats = await stat(file).catch(() => undefined);
    if (!stats) { this.#cache.delete(file); return undefined; }
    const signature = fileSignature(stats);
    const cached = this.#cache.get(file);
    if (cached?.signature === signature) {
      this.#cache.delete(file);
      this.#cache.set(file, cached);
      return cached.manager;
    }
    // Reuse entries only when the file grew from where it was read and needs no migration. Pi only appends to a
    // session in its current version, so its first and last bytes as read tell an append from a rewrite. Reading
    // all of it again for every append made each message wait on hundreds of MB in a long session.
    const appended = cached?.appendable && cached.offset === cached.size && cached.inode === stats.ino && stats.size > cached.size
      && await fileSample(file, cached.size) === cached.sample;
    const entries = appended ? [...cached.entries] : [];
    const start = appended ? cached.offset : 0;
    let offset = start;
    // Inline images can make one record tens of MB. Collect bytes until its
    // newline instead of repeatedly copying and scanning an incomplete string.
    let fragments: Buffer[] = [];
    let pendingBytes = 0;
    if (stats.size > start) {
      for await (const chunk of createReadStream(file, { start, end: stats.size - 1, highWaterMark: 64 * 1024 })) {
        const bytes = chunk as Buffer;
        let chunkStart = 0;
        for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, chunkStart)) {
          fragments.push(bytes.subarray(chunkStart, newline));
          pendingBytes += newline - chunkStart;
          const line = Buffer.concat(fragments, pendingBytes).toString("utf8");
          offset += pendingBytes + 1;
          fragments = [];
          pendingBytes = 0;
          for (const entry of parseSessionEntries(line)) {
            entries.push(this.#projectEntry(project.id, entry));
          }
          chunkStart = newline + 1;
        }
        if (chunkStart < bytes.length) {
          fragments.push(bytes.subarray(chunkStart));
          pendingBytes += bytes.length - chunkStart;
        }
        // Bound parsing and media work between event-loop turns, including buffered lines.
        await this.images?.flush(project.id);
        await setImmediate();
      }
      const trailing = parseSessionEntries(Buffer.concat(fragments, pendingBytes).toString("utf8"));
      if (trailing.length) {
        entries.push(...trailing.map((entry) => this.#projectEntry(project.id, entry)));
        offset = stats.size;
      }
    }
    if (entries[0]?.type !== "session") return undefined;
    const appendable = entries[0].version === CURRENT_SESSION_VERSION;
    const manager = SessionManager.inMemory(project.workspacePath, undefined, entries);
    const loaded = { signature, inode: stats.ino, size: stats.size, offset,
      sample: await fileSample(file, stats.size), appendable, entries, manager };
    this.#cache.delete(file);
    this.#cache.set(file, loaded);
    while (this.#cache.size > 32) this.#cache.delete(this.#cache.keys().next().value!);
    // A run may finish while this asynchronous read yields. Include its final append.
    const latest = await stat(file).catch(() => undefined);
    if (!latest || fileSignature(latest) !== signature) return this.#read(project, file);
    return manager;
  }

  #projectEntry(projectId: string, entry: FileEntry): FileEntry {
    const message = entry.type === "message" ? entry.message : entry.type === "custom_message" ? entry
      : entry.type === "context_edit" ? entry.replacement : undefined;
    if (!message || !("content" in message) || !Array.isArray(message.content)) return entry;
    if ("role" in message && message.role === "toolResult") message.content = shownToolOutput(message.content as { type: string }[]) as typeof message.content;
    if (!this.images) return entry;
    message.content = message.content.map((content) => {
      if (content.type !== "image") return content;
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(content.mimeType)) return { ...content, data: "" };
      const reference = this.images!.project(projectId, { mediaType: content.mimeType as PromptImage["mediaType"], data: content.data });
      return { ...content, data: "", url: reference.url };
    }) as typeof message.content;
    return entry;
  }
}

/**
 * Keeps only the tool output a conversation shows, which is all this view needs.
 * The chat joins a result's text before shortening it, so this does too and it shows the same.
 */
function shownToolOutput<T extends { type: string }>(content: T[]): T[] {
  const text = (block: T): block is T & { text: string } => block.type === "text" && typeof (block as { text?: unknown }).text === "string";
  const joined = content.filter(text).map((block) => block.text).join("");
  if (joined.length <= MAX_TOOL_OUTPUT) return content;
  // A slice of a string keeps the whole string in memory. Copying lets it go.
  const shown = JSON.parse(JSON.stringify(boundToolOutput(joined))) as string;
  const first = content.find(text);
  return content.flatMap((block) => block === first ? [{ ...block, text: shown }] : text(block) ? [] : [block]);
}

/** How much of a session's start and end tells an append from a rewrite. */
const SAMPLE_BYTES = 64 * 1024;

/** A digest of the first and last bytes of the file's first `size` bytes, which hold its header and latest records. */
async function fileSample(file: string, size: number): Promise<string> {
  const hash = createHash("sha256").update(String(size));
  const handle = await open(file, "r");
  try {
    for (const start of new Set([0, Math.max(0, size - SAMPLE_BYTES)])) {
      const bytes = Buffer.alloc(Math.min(SAMPLE_BYTES, size - start));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      hash.update(bytes.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function fileSignature(stats: { ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function sessionInfo(manager: SessionManager, file: string, mtime: Date): ConversationInfo {
  const header = manager.getHeader()!;
  const messages = manager.getEntries().filter((entry) => entry.type === "message");
  let firstMessage = "";
  let latestActivity = 0;
  for (const entry of messages) {
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
    if (Number.isFinite(time)) latestActivity = Math.max(latestActivity, time);
    if (message.role === "user" && !firstMessage) {
      const content = message.content;
      firstMessage = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
    }
  }
  const headerTime = Date.parse(header.timestamp);
  // A newly forked chat is recent even when its copied messages are old.
  const activity = header.parentSession && Number.isFinite(headerTime) ? Math.max(latestActivity, headerTime) : latestActivity;
  return { path: file, id: manager.getSessionId(), name: manager.getSessionName(),
    created: new Date(header.timestamp), modified: activity > 0 ? new Date(activity) : Number.isFinite(headerTime) ? new Date(headerTime) : mtime,
    messageCount: messages.length, firstMessage: firstMessage || "(no messages)" };
}
