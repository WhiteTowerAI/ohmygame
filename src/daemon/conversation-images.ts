import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PromptImage, RuntimeEvent, ThreadItem } from "../shared/contracts.js";

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;

/** Disposable UI media cache. The authoritative images remain in Pi's session. */
export class ConversationImageStore {
  readonly #references = new WeakMap<PromptImage, Map<string, PromptImage>>();
  readonly #writes = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  project(projectId: string, image: PromptImage): PromptImage {
    if (!image.data) return image;
    const cached = this.#references.get(image)?.get(projectId);
    if (cached) return cached;
    const id = `${createHash("sha256").update(image.data).digest("hex")}.${EXTENSIONS[image.mediaType]}`;
    const file = this.#file(projectId, id);
    if (!this.#writes.has(file)) {
      const write = this.#write(file, image.data);
      this.#writes.set(file, write);
      // Keep only pending writes; references are weak and do not retain image payloads.
      void write.finally(() => this.#writes.delete(file)).catch(() => {});
    }
    const reference = { mediaType: image.mediaType, data: "", ...(image.name ? { name: image.name } : {}),
      url: `/projects/${encodeURIComponent(projectId)}/conversation-images/${id}` };
    const references = this.#references.get(image) ?? new Map<string, PromptImage>();
    references.set(projectId, reference);
    this.#references.set(image, references);
    void this.#writes.get(file)?.catch(() => references.delete(projectId));
    return reference;
  }

  item(projectId: string, item: ThreadItem): ThreadItem {
    if (!("images" in item) || !item.images?.length) return item;
    return { ...item, images: item.images.map((image) => this.project(projectId, image)) };
  }

  event<T extends RuntimeEvent>(event: T): T {
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      return { ...event, data: { item: this.item(event.projectId, event.data.item) } } as T;
    }
    if ((event.type === "agent.started" || event.type === "prompt.queued" || event.type === "prompt.steered") && event.data.images?.length) {
      return { ...event, data: { ...event.data, images: event.data.images.map((image) => this.project(event.projectId, image)) } } as T;
    }
    return event;
  }

  async read(projectId: string, id: string): Promise<{ data: Buffer; mediaType: string } | undefined> {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(id)) return undefined;
    const file = this.#file(projectId, id);
    await this.#writes.get(file);
    try {
      const data = await readFile(file);
      const extension = id.split(".").at(-1);
      return { data, mediaType: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  async flush(projectId?: string): Promise<void> {
    const directory = projectId === undefined ? undefined : path.dirname(this.#file(projectId, "image"));
    await Promise.allSettled([...this.#writes].filter(([file]) => !directory || path.dirname(file) === directory).map(([, write]) => write));
  }

  async removeProject(projectId: string): Promise<void> {
    const directory = path.dirname(this.#file(projectId, "image"));
    await this.flush(projectId);
    await rm(directory, { recursive: true, force: true });
  }

  async #write(file: string, data: string): Promise<void> {
    const existing = await stat(file).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
      return undefined;
    });
    if (existing?.size === Buffer.byteLength(data, "base64")) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.from(data, "base64"), { flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  #file(projectId: string, id: string): string {
    // Project IDs are directory keys, never caller-supplied filesystem paths.
    return path.join(this.directory, createHash("sha256").update(projectId).digest("hex"), id);
  }
}
