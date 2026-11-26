import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_LOCAL_DIRECTORY } from "../shared/project-layout.js";
import { CanvasError } from "./canvas-files.js";

// A failed or cancelled job keeps its input so Retry can send it again. Reference
// images in it are saved once each, by content, in the project's local folder,
// and the history names them: inline, every job repeated megabytes of the same
// picture, and each history write rewrote all of them.
const DIRECTORY = [...PROJECT_LOCAL_DIRECTORY.split("/"), "canvas-job-inputs"];
const NAME = /^[a-f0-9]{64}$/;

/** An inline picture in a tool input, such as a `PromptImage`. */
const isInline = (value: Record<string, unknown>): boolean =>
  typeof value.mediaType === "string" && typeof value.data === "string" && value.data.length > 0 && value.dataFile === undefined;
const isStored = (value: Record<string, unknown>): value is Record<string, unknown> & { dataFile: string } =>
  typeof value.dataFile === "string";

async function folder(workspace: string, create: boolean): Promise<string | undefined> {
  let directory = workspace;
  for (const part of DIRECTORY) {
    directory = path.join(directory, part);
    if (create) await mkdir(directory).catch((cause) => { if (cause.code !== "EEXIST") throw cause; });
    const entry = await lstat(directory).catch((cause) => { if (cause.code === "ENOENT") return undefined; throw cause; });
    if (!entry) return undefined;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CanvasError("Canvas job inputs must be a folder, not a link");
  }
  return directory;
}

async function map(value: unknown, change: (item: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => map(item, change)));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const changed = await change(record);
  if (changed) return changed;
  return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await map(item, change)] as const)));
}

/** The input to keep in the history: each inline picture saved to a file and named by `dataFile`. */
export async function storeJobInput<T>(workspace: string, input: T): Promise<T> {
  let directory: string | undefined;
  return await map(input, async (item) => {
    if (!isInline(item)) return undefined;
    const bytes = Buffer.from(item.data as string, "base64"), name = createHash("sha256").update(bytes).digest("hex");
    directory ??= await folder(workspace, true);
    await writeFile(path.join(directory!, name), bytes, { flag: "wx" }).catch((cause) => { if (cause.code !== "EEXIST") throw cause; });
    const { data: _, ...rest } = item;
    return { ...rest, data: "", dataFile: name };
  }) as T;
}

/** The input as it was sent, its saved pictures read back. */
export async function restoreJobInput<T>(workspace: string, input: T): Promise<T> {
  const directory = await folder(workspace, false);
  return await map(input, async (item) => {
    if (!isStored(item)) return undefined;
    const bytes = NAME.test(item.dataFile) && directory ? await readFile(path.join(directory, item.dataFile)).catch(() => undefined) : undefined;
    if (!bytes) throw new CanvasError("A reference image saved for this job is missing. Generate the node again.", 409);
    const { dataFile: _, ...rest } = item;
    return { ...rest, data: bytes.toString("base64") };
  }) as T;
}

/** Whether an input still holds a picture inline, as history from before saved pictures did. */
export function hasInlineImages(input: unknown): boolean {
  if (Array.isArray(input)) return input.some(hasInlineImages);
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return isInline(record) || Object.values(record).some(hasInlineImages);
}

/** Deletes saved pictures that no input in the history names any more. */
export async function pruneJobInputs(workspace: string, inputs: unknown[]): Promise<void> {
  const directory = await folder(workspace, false);
  if (!directory) return;
  const used = new Set<string>();
  await map(inputs, async (item) => { if (isStored(item)) used.add(item.dataFile); return undefined; });
  for (const name of await readdir(directory)) if (NAME.test(name) && !used.has(name)) await rm(path.join(directory, name), { force: true });
}
