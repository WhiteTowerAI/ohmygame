import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { IMAGE_ASPECT_RATIOS, IMAGE_OUTPUT_COUNTS, IMAGE_RESOLUTIONS, MODEL_3D_MODELS, MODEL_3D_POSES, MODEL_3D_QUALITIES, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from "../shared/contracts.js";
import type { AssetStudioDraft } from "../shared/asset-studio-draft.js";

interface StoredDraft extends AssetStudioDraft {
  version: 1;
}

export class AssetStudioDraftStore {
  readonly #filePath: string;
  #draft: AssetStudioDraft | undefined;
  #writes = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "asset-studio-draft.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (!isStoredDraft(value)) throw new Error(`Invalid Asset Studio draft: ${this.#filePath}`);
      this.#draft = publicDraft(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): AssetStudioDraft | undefined {
    return this.#draft ? structuredClone(this.#draft) : undefined;
  }

  async update(value: unknown): Promise<AssetStudioDraft> {
    if (!record(value)) throw new Error("Invalid Asset Studio draft");
    const stored = { version: 1, ...value };
    if (!isStoredDraft(stored)) throw new Error("Invalid Asset Studio draft");
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, this.#filePath);
        this.#draft = publicDraft(stored);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.#writes = write.catch(() => undefined);
    await write;
    return this.get()!;
  }
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (!record(value) || value.version !== 1 || !mode(value.mode) || !record(value.templateIds)) return false;
  if (!onlyKeys(value, ["version", "mode", "templateIds", "panelView", "selectedRunId", "selectedOutput", "image", "video", "model3D"])) return false;
  if (!onlyKeys(value.templateIds, ["image", "video", "3d"])) return false;
  if (!optionalText(value.templateIds.image, 200) || !optionalText(value.templateIds.video, 200) || !optionalText(value.templateIds["3d"], 200)) return false;
  if (value.panelView !== "templates" && value.panelView !== "history") return false;
  if (value.selectedRunId !== undefined && !text(value.selectedRunId, 100)) return false;
  if (value.selectedOutput !== undefined && (!Number.isInteger(value.selectedOutput) || Number(value.selectedOutput) < 0 || Number(value.selectedOutput) > 3)) return false;
  if (!record(value.image) || !onlyKeys(value.image, ["prompt", "resolution", "aspectRatio", "outputs"])
    || !text(value.image.prompt, 32_000) || !member(value.image.resolution, IMAGE_RESOLUTIONS)
    || !member(value.image.aspectRatio, IMAGE_ASPECT_RATIOS) || !member(value.image.outputs, IMAGE_OUTPUT_COUNTS)) return false;
  if (!record(value.video) || !onlyKeys(value.video, ["prompt", "resolution", "aspectRatio", "duration"])
    || !text(value.video.prompt, 32_000) || !member(value.video.resolution, VIDEO_RESOLUTIONS)
    || !member(value.video.aspectRatio, VIDEO_ASPECT_RATIOS) || !integer(value.video.duration, 4, 15)) return false;
  if (!record(value.model3D) || !onlyKeys(value.model3D, ["prompt", "model", "source", "multiView", "quality", "targetPolycount", "texture", "pose", "imageEnhancement"])
    || !text(value.model3D.prompt, 32_000) || !member(value.model3D.model, MODEL_3D_MODELS)
    || !mode3DSource(value.model3D.source) || typeof value.model3D.multiView !== "boolean"
    || !member(value.model3D.quality, MODEL_3D_QUALITIES) || !integer(value.model3D.targetPolycount, 100, 15_000)
    || typeof value.model3D.texture !== "boolean" || !member(value.model3D.pose, MODEL_3D_POSES)
    || typeof value.model3D.imageEnhancement !== "boolean") return false;
  return true;
}

function publicDraft({ version: _, ...draft }: StoredDraft): AssetStudioDraft {
  return structuredClone(draft);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function optionalText(value: unknown, maximum: number): value is string | undefined {
  return value === undefined || text(value, maximum);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function member<T>(value: unknown, values: readonly T[]): value is T {
  return values.includes(value as T);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function mode(value: unknown): value is AssetStudioDraft["mode"] {
  return value === "image" || value === "video" || value === "3d";
}

function mode3DSource(value: unknown): value is AssetStudioDraft["model3D"]["source"] {
  return value === "image" || value === "text";
}
