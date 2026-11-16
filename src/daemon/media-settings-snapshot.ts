import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export type Snapshot<File extends string = string> = Map<
  File,
  Buffer | undefined
>;

export async function snapshot<File extends string>(
  directory: string,
  files: readonly File[],
): Promise<Snapshot<File>> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Expected an owned data directory");
  const result: Snapshot<File> = new Map();
  for (const file of files) {
    try {
      if (file.includes("/")) {
        const parent = await lstat(path.join(directory, path.dirname(file)));
        if (!parent.isDirectory() || parent.isSymbolicLink())
          throw new Error("Linked settings directory");
      }
      const location = path.join(directory, file),
        entry = await lstat(location);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Invalid settings file");
      result.set(file, await readFile(location));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      result.set(file, undefined);
    }
  }
  return result;
}

export function equal(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.equals(b);
}
export function same<File extends string>(
  a: Snapshot<File>,
  b: Snapshot<File>,
  files: readonly File[],
): boolean {
  return files.every((file) => equal(a.get(file), b.get(file)));
}
