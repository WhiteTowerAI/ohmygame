import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isAssetTemplateDefinition,
  type CreateAssetTemplateRequest,
  type LocalAssetTemplate,
} from "../shared/asset-templates.js";

export class AssetTemplateError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export class AssetTemplateStore {
  readonly #file: string;
  readonly #coversDirectory: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, "asset-templates.json");
    this.#coversDirectory = path.join(dataDirectory, "asset-template-covers");
  }

  async list(): Promise<LocalAssetTemplate[]> {
    await this.#writes;
    return this.#read();
  }

  async create(input: CreateAssetTemplateRequest): Promise<LocalAssetTemplate> {
    if (!isAssetTemplateDefinition(input)) throw new AssetTemplateError("Asset template is invalid");
    const template: LocalAssetTemplate = {
      ...normalized(input), id: randomUUID(), source: "local", createdAt: new Date().toISOString(),
    };
    await this.#mutate(async () => this.#write([...await this.#read(), template]));
    return template;
  }

  async read(id: string): Promise<LocalAssetTemplate | undefined> {
    await this.#writes;
    return (await this.#read()).find((template) => template.id === id);
  }

  async setPublication(id: string, publication: NonNullable<LocalAssetTemplate["publication"]>): Promise<LocalAssetTemplate> {
    let updated: LocalAssetTemplate | undefined;
    await this.#mutate(async () => {
      const templates = await this.#read();
      const index = templates.findIndex((template) => template.id === id);
      if (index < 0) throw new AssetTemplateError("Asset template not found", 404);
      updated = { ...templates[index]!, publication };
      templates[index] = updated;
      await this.#write(templates);
    });
    return updated!;
  }

  async delete(id: string): Promise<void> {
    await this.#mutate(async () => {
      const templates = await this.#read();
      const remaining = templates.filter((template) => template.id !== id);
      if (remaining.length === templates.length) throw new AssetTemplateError("Asset template not found", 404);
      await this.#write(remaining);
      await rm(this.#coverFile(id), { force: true });
    });
  }

  async setCover(id: string, cover: Buffer): Promise<LocalAssetTemplate> {
    let updated: LocalAssetTemplate | undefined;
    await this.#mutate(async () => {
      const templates = await this.#read();
      const index = templates.findIndex((template) => template.id === id);
      if (index < 0) throw new AssetTemplateError("Asset template not found", 404);
      await mkdir(this.#coversDirectory, { recursive: true });
      const temporary = `${this.#coverFile(id)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, cover, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.#coverFile(id));
      } finally {
        await rm(temporary, { force: true });
      }
      updated = { ...templates[index]!, hasCover: true };
      templates[index] = updated;
      await this.#write(templates);
    });
    return updated!;
  }

  async cover(id: string): Promise<Buffer | undefined> {
    const template = await this.read(id);
    if (!template?.hasCover) return undefined;
    return readFile(this.#coverFile(id)).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
  }

  #coverFile(id: string): string {
    return path.join(this.#coversDirectory, `${id}.webp`);
  }

  #mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.#writes.then(operation);
    this.#writes = result.catch(() => undefined);
    return result;
  }

  async #read(): Promise<LocalAssetTemplate[]> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#file, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AssetTemplateError("Could not read saved Asset templates");
    }
    if (!Array.isArray(value) || !value.every(isLocalTemplate)) throw new AssetTemplateError("Saved Asset templates are invalid");
    return value;
  }

  async #write(templates: LocalAssetTemplate[]): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(templates, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function isLocalTemplate(value: unknown): value is LocalAssetTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as Partial<LocalAssetTemplate>;
  const publication = template.publication;
  const { id: _id, source: _source, createdAt: _createdAt, hasCover: _hasCover, publication: _publication, ...definition } = template;
  return template.source === "local" && typeof template.id === "string" && Boolean(template.id)
    && typeof template.createdAt === "string" && !Number.isNaN(Date.parse(template.createdAt))
    && (template.hasCover === undefined || typeof template.hasCover === "boolean")
    && isAssetTemplateDefinition(definition)
    && (publication === undefined || validPublication(publication));
}

function validPublication(value: unknown): value is NonNullable<LocalAssetTemplate["publication"]> {
  if (!value || typeof value !== "object") return false;
  const publication = value as Record<string, unknown>;
  return typeof publication.templateId === "string" && Boolean(publication.templateId)
    && typeof publication.releaseId === "string" && Boolean(publication.releaseId)
    && typeof publication.publishedAt === "string" && !Number.isNaN(Date.parse(publication.publishedAt))
    && (publication.status === "listed" || publication.status === "unlisted");
}

function normalized(input: CreateAssetTemplateRequest): CreateAssetTemplateRequest {
  const { promptLabel: _, ...definition } = input;
  return {
    ...definition,
    name: input.name.trim(),
    description: input.description.trim(),
    promptPlaceholder: input.promptPlaceholder.trim(),
    ...(input.previewTemplateId?.trim() ? { previewTemplateId: input.previewTemplateId.trim() } : { previewTemplateId: undefined }),
    ...(input.defaultPrompt?.trim() ? { defaultPrompt: input.defaultPrompt.trim() } : { defaultPrompt: undefined }),
  };
}
