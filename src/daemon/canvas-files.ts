import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check, Errors } from "typebox/value";

export class CanvasError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }

export async function canvasPath(workspace: string, name: string, create = false): Promise<string> {
  const segments = name.split("/");
  if (segments.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")) throw new CanvasError("Invalid canvas path");
  let directory = workspace;
  for (const part of ["canvas", ...segments.slice(0, -1)]) {
    directory = path.join(directory, part);
    if (create) await mkdir(directory).catch((cause) => { if (cause.code !== "EEXIST") throw cause; });
    if ((await lstat(directory)).isSymbolicLink()) throw new CanvasError("Canvas directories must not be symbolic links");
  }
  const file = path.join(directory, segments.at(-1)!);
  try { if ((await lstat(file)).isSymbolicLink()) throw new CanvasError("Canvas files must not be symbolic links"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  return file;
}

export async function readCanvasFile(workspace: string, name: string, limit = 4 * 1024 * 1024): Promise<string | undefined> {
  try {
    const text = await readFile(await canvasPath(workspace, name), "utf8");
    if (Buffer.byteLength(text) > limit) throw new CanvasError(`canvas/${name}: file is too large`);
    return text;
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
}

export function parseCanvasJson<T>(text: string, name: string, schema: object): T {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CanvasError(`canvas/${name}: invalid JSON`); }
  if (!Check(schema, value)) {
    const issues = [...Errors(schema, value)].slice(0, 8).map((issue) => `${issue.instancePath || "/"}: ${issue.message}`);
    throw new CanvasError(`canvas/${name}: ${issues.join("; ")}`);
  }
  return value as T;
}

export async function writeCanvasFile(workspace: string, name: string, text: string): Promise<void> {
  const destination = await canvasPath(workspace, name, true), temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { encoding: "utf8", flag: "wx" }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export const writeCanvasJson = (workspace: string, name: string, value: unknown) => writeCanvasFile(workspace, name, `${JSON.stringify(value, null, 2)}\n`);
