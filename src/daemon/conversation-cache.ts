import { createReadStream } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager, type FileEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { PromptImage, ProjectState } from "../shared/contracts.js";
import type { ConversationImageStore } from "./conversation-images.js";

interface CachedSession {
  signature: string;
  inode: number;
  size: number;
  offset: number;
  digest: string;
  appendable: boolean;
  entries: FileEntry[];
  manager: SessionManager;
}

export type ConversationInfo = Pick<SessionInfo, "path" | "id" | "name" | "created" | "modified" | "messageCount" | "firstMessage">;

/** Read-only UI view. Never pass these image-free managers to an agent. */
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

  async read(project: ProjectState, file: string): Promise<SessionManager | undefined> {
    const loading = this.#loading.get(file);
    if (loading) return loading;
    const promise = this.#read(project, file);
    this.#loading.set(file, promise);
    try { return await promise; }
    finally { this.#loading.delete(file); }
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
    // Reuse entries only when the entire old prefix is unchanged and needs no migration.
    const prefix = cached?.appendable && cached.offset === cached.size && cached.inode === stats.ino && stats.size > cached.size
      ? await hashPrefix(file, cached.size) : undefined;
    const appended = cached && prefix?.copy().digest("hex") === cached.digest;
    const hash = appended ? prefix! : createHash("sha256");
    const entries = appended ? [...cached.entries] : [];
    const start = appended ? cached.offset : 0;
    let offset = start;
    let pending = "";
    const decoder = new StringDecoder("utf8");
    if (stats.size > start) {
      for await (const chunk of createReadStream(file, { start, end: stats.size - 1, highWaterMark: 64 * 1024 })) {
        hash.update(chunk as Buffer);
        pending += decoder.write(chunk as Buffer);
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          offset += Buffer.byteLength(line) + 1;
          for (const entry of parseSessionEntries(line)) {
            entries.push(this.#projectEntry(project.id, entry));
          }
        }
        // Bound parsing and media work between event-loop turns, including buffered lines.
        await this.images?.flush(project.id);
        await setImmediate();
      }
      pending += decoder.end();
      const trailing = parseSessionEntries(pending);
      if (trailing.length) {
        entries.push(...trailing.map((entry) => this.#projectEntry(project.id, entry)));
        offset = stats.size;
      }
    }
    if (entries[0]?.type !== "session") return undefined;
    const appendable = entries[0].version === CURRENT_SESSION_VERSION;
    const manager = SessionManager.inMemory(project.workspacePath, undefined, entries);
    const loaded = { signature, inode: stats.ino, size: stats.size, offset,
      digest: hash.digest("hex"), appendable, entries, manager };
    this.#cache.delete(file);
    this.#cache.set(file, loaded);
    while (this.#cache.size > 32) this.#cache.delete(this.#cache.keys().next().value!);
    // A run may finish while this asynchronous read yields. Include its final append.
    const latest = await stat(file).catch(() => undefined);
    if (!latest || fileSignature(latest) !== signature) return this.#read(project, file);
    return manager;
  }

  #projectEntry(projectId: string, entry: FileEntry): FileEntry {
    if (!this.images) return entry;
    const message = entry.type === "message" ? entry.message : entry.type === "custom_message" ? entry
      : entry.type === "context_edit" ? entry.replacement : undefined;
    if (!message || !("content" in message) || !Array.isArray(message.content)) return entry;
    message.content = message.content.map((content) => {
      if (content.type !== "image") return content;
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(content.mimeType)) return { ...content, data: "" };
      const reference = this.images!.project(projectId, { mediaType: content.mimeType as PromptImage["mediaType"], data: content.data });
      return { ...content, data: "", url: reference.url };
    }) as typeof message.content;
    return entry;
  }
}

async function hashPrefix(file: string, size: number): Promise<Hash> {
  const hash = createHash("sha256");
  if (size) for await (const chunk of createReadStream(file, { end: size - 1, highWaterMark: 64 * 1024 })) {
    hash.update(chunk as Buffer);
    await setImmediate();
  }
  return hash;
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
  return { path: file, id: manager.getSessionId(), name: manager.getSessionName(),
    created: new Date(header.timestamp), modified: latestActivity > 0 ? new Date(latestActivity)
      : Number.isFinite(headerTime) ? new Date(headerTime) : mtime,
    messageCount: messages.length, firstMessage: firstMessage || "(no messages)" };
}
