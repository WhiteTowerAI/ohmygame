import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES, type DesktopClipboardFile } from "../shared/file-transfer.js";

interface FileClipboard {
  availableFormats(): string[];
  readBuffer(format: string): Buffer;
}

export function parseFileUrls(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap((line) => {
    try {
      const url = new URL(line.trim().replace(/\0+$/, ""));
      return url.protocol === "file:" ? [fileURLToPath(url)] : [];
    } catch { return []; }
  });
}

export function parseWindowsFileDrop(buffer: Buffer): string[] {
  if (buffer.length < 20) return [];
  const offset = buffer.readUInt32LE(0);
  if (offset < 20 || offset >= buffer.length) return [];
  const text = buffer.subarray(offset).toString(buffer.readUInt32LE(16) ? "utf16le" : "latin1");
  return text.split("\0").filter((filePath) => path.win32.isAbsolute(filePath));
}

function macFileList(buffer: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
      if (error) { reject(new Error("Could not read files from the clipboard.")); return; }
      try {
        const paths: unknown = JSON.parse(output);
        resolve(Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry)) : []);
      } catch { reject(new Error("Could not read files from the clipboard.")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(buffer);
  });
}

export async function clipboardFilePaths(clipboard: FileClipboard, platform = process.platform): Promise<string[]> {
  const formats = new Set(clipboard.availableFormats());
  // Snapshot the native payload before awaiting plist conversion or filesystem reads.
  if (platform === "darwin" && formats.has("NSFilenamesPboardType")) return macFileList(clipboard.readBuffer("NSFilenamesPboardType"));
  if (platform === "win32" && formats.has("CF_HDROP")) return parseWindowsFileDrop(clipboard.readBuffer("CF_HDROP"));
  for (const format of ["public.file-url", "text/uri-list", "x-special/gnome-copied-files"]) {
    if (formats.has(format)) return parseFileUrls(clipboard.readBuffer(format).toString("utf8"));
  }
  return [];
}

export async function loadClipboardFiles(paths: string[]): Promise<DesktopClipboardFile[]> {
  const entries: Array<{ filePath: string; relativePath: string; size: number; lastModified: number }> = [];
  const visited = new Set<string>();
  let totalBytes = 0, scanned = 0;
  async function visit(filePath: string, relativePath: string, depth: number): Promise<void> {
    if (++scanned > 10_000 || depth > 32) throw new Error("The copied folder is too large.");
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const child of (await readdir(filePath)).sort()) await visit(path.join(filePath, child), `${relativePath}/${child}`, depth + 1);
    } else if (info.isFile() && !visited.has(filePath)) {
      if (info.size > MAX_ATTACHMENT_BYTES) throw new Error("An attachment cannot exceed 500 MB");
      if (entries.length >= MAX_ATTACHMENT_FILES) throw new Error("Attach at most 1,000 files at a time");
      totalBytes += info.size;
      if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) throw new Error("Attached files cannot exceed 1 GB in total");
      visited.add(filePath);
      entries.push({ filePath, relativePath, size: info.size, lastModified: info.mtimeMs });
    }
  }
  for (const filePath of new Set(paths)) {
    if (!path.isAbsolute(filePath)) continue;
    await visit(filePath, path.basename(filePath), 0);
  }
  const files: DesktopClipboardFile[] = [];
  for (const entry of entries) {
    const bytes = await readFile(entry.filePath);
    if (bytes.byteLength !== entry.size) throw new Error("A copied file changed while reading. Copy it again.");
    files.push({ name: path.basename(entry.filePath), relativePath: entry.relativePath, lastModified: entry.lastModified, bytes });
  }
  return files;
}
