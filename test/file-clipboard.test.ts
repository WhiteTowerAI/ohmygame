import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clipboardFilePaths, loadClipboardFiles, parseFileUrls, parseWindowsFileDrop } from "../src/desktop/file-clipboard.js";
import { MAX_ATTACHMENT_BYTES } from "../src/shared/file-transfer.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("native file clipboard", () => {
  it("reads file URLs while excluding other URLs and file-manager commands", () => {
    expect(parseFileUrls("copy\r\nfile:///tmp/game%20rules.md\r\n# comment\nhttps://example.com/file\nfile:///tmp/art.png\0")).toEqual(["/tmp/game rules.md", "/tmp/art.png"]);
  });

  it("decodes Windows Unicode DROPFILES and rejects malformed offsets", () => {
    const header = Buffer.alloc(20);
    header.writeUInt32LE(20, 0); header.writeUInt32LE(1, 16);
    expect(parseWindowsFileDrop(Buffer.concat([header, Buffer.from("C:\\games\\rules.md\0C:\\games\\art.png\0\0", "utf16le")]))).toEqual(["C:\\games\\rules.md", "C:\\games\\art.png"]);
    header.writeUInt32LE(999, 0);
    expect(parseWindowsFileDrop(header)).toEqual([]);
  });

  it("converts the macOS file plist using the system parser", async () => {
    if (process.platform !== "darwin") return;
    const plist = Buffer.from('<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>/tmp/rules.md</string><string>/tmp/hero.png</string></array></plist>');
    expect(await clipboardFilePaths({ availableFormats: () => ["NSFilenamesPboardType"], readBuffer: () => plist }, "darwin")).toEqual(["/tmp/rules.md", "/tmp/hero.png"]);
  });

  it("does not interpret ordinary clipboard text as a filesystem path", async () => {
    expect(await clipboardFilePaths({ availableFormats: () => ["text/plain"], readBuffer: () => Buffer.from("/tmp/private.md") }, "linux")).toEqual([]);
  });

  it("preserves folder paths and deduplicates files without following symlinks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-clipboard-")); directories.push(directory);
    const folder = path.join(directory, "game"), file = path.join(folder, "rules.md");
    await mkdir(path.join(folder, "art"), { recursive: true });
    await writeFile(file, "# Game rules");
    await writeFile(path.join(folder, "art", "hero.txt"), "hero");
    await symlink(directory, path.join(folder, "loop"));
    const loaded = await loadClipboardFiles([folder, file, folder]);
    expect(loaded.map((entry) => entry.relativePath)).toEqual(["game/art/hero.txt", "game/rules.md"]);
    expect(Buffer.from(loaded[1]!.bytes).toString()).toBe("# Game rules");
    expect(loaded[1]!.lastModified).toBeGreaterThan(0);
  });

  it("checks file size before loading bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-clipboard-")); directories.push(directory);
    const file = path.join(directory, "huge.bin"), handle = await open(file, "w");
    try { await handle.truncate(MAX_ATTACHMENT_BYTES + 1); } finally { await handle.close(); }
    await expect(loadClipboardFiles([file])).rejects.toThrow("500 MB");
  });
});
