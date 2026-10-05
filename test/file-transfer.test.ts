import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { clipboardFiles, pasteNativeFiles, transferredFiles } from "../src/renderer/file-transfer.js";
import { appendAttachments, attachmentFiles, uploadAttachments } from "../src/renderer/composer-attachments.js";
import * as api from "../src/renderer/api.js";
import { MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES } from "../src/shared/file-transfer.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("renderer file transfers", () => {
  it("accepts clipboard files and falls back to file items for pasted screenshots", () => {
    const file = new File(["image"], "screenshot.png", { type: "image/png" });
    expect(clipboardFiles({ files: [file], items: [] } as unknown as DataTransfer)).toEqual([file]);
    expect(clipboardFiles({ files: [], items: [{ kind: "file", getAsFile: () => file }, { kind: "string" }] } as unknown as DataTransfer)).toEqual([file]);
  });

  it("captures a dropped folder and reads every directory batch", async () => {
    const file = new File(["rules"], "rules.md");
    const entry = { isFile: true, name: file.name, file: (callback: (file: File) => void) => callback(file) };
    let batch = 0;
    const folder = { isDirectory: true, name: "game", createReader: () => ({ readEntries: (callback: (entries: unknown[]) => void) => callback(++batch === 1 ? [entry] : []) }) };
    const transfer = { files: [], items: [{ kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => null }] } as unknown as DataTransfer;
    expect(await transferredFiles(transfer)).toEqual([{ file, relativePath: "game/rules.md" }]);
    expect(batch).toBe(2);
  });

  it("preserves nested attachment paths and validates duplicates across batches", () => {
    const file = new File(["rules"], "rules.md");
    const first = attachmentFiles([{ file, relativePath: "game/rules.md" }]);
    expect(first[0]!.relativePath).toBe("game/rules.md");
    expect(() => appendAttachments(first, attachmentFiles([{ file, relativePath: "game/rules.md" }]))).toThrow("already attached");
    expect(appendAttachments(first, attachmentFiles([{ file, relativePath: "other/rules.md" }]))).toHaveLength(2);
  });

  it("rejects large attachment batches before upload", () => {
    const attachment = (size: number, relativePath: string) => ({ id: relativePath, relativePath, file: { size } as File });
    expect(() => appendAttachments([], [attachment(MAX_ATTACHMENT_BYTES + 1, "huge")])).toThrow("500 MB");
    expect(() => appendAttachments([], Array.from({ length: 1_001 }, (_, i) => attachment(1, String(i))))).toThrow("1,000 files");
    expect(() => appendAttachments([], [attachment(MAX_ATTACHMENT_BYTES, "1"), attachment(MAX_ATTACHMENT_BYTES, "2"), attachment(MAX_ATTACHMENT_BYTES, "3")])).toThrow("1 GB");
  });

  it("routes native copied files to attachments and preserves image types", async () => {
    const target = { isConnected: true };
    const paste = vi.fn();
    vi.stubGlobal("document", { activeElement: target });
    vi.stubGlobal("window", { ohMyGameDesktop: { clipboard: { files: async () => [{ name: "hero.png", relativePath: "art/hero.png", bytes: new Uint8Array([1, 2]), lastModified: 123 }], paste } } });
    const onFiles = vi.fn(), preventDefault = vi.fn();
    pasteNativeFiles({ target, metaKey: true, key: "v", nativeEvent: {}, preventDefault } as unknown as KeyboardEvent<HTMLElement>, onFiles);
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledOnce());
    const [{ file, relativePath }] = onFiles.mock.calls[0]![0];
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(relativePath).toBe("art/hero.png");
    expect(file.type).toBe("image/png");
    expect(file.lastModified).toBe(123);
    expect(paste).not.toHaveBeenCalled();
  });

  it("returns ordinary text paste to Electron and ignores composition shortcuts", async () => {
    const target = { isConnected: true }, files = vi.fn(async () => []), paste = vi.fn();
    vi.stubGlobal("document", { activeElement: target });
    vi.stubGlobal("window", { ohMyGameDesktop: { clipboard: { files, paste } } });
    const event = { target, ctrlKey: true, key: "v", nativeEvent: { isComposing: true }, preventDefault: vi.fn() };
    pasteNativeFiles(event as unknown as KeyboardEvent<HTMLElement>, vi.fn());
    expect(files).not.toHaveBeenCalled();
    event.nativeEvent.isComposing = false;
    pasteNativeFiles(event as unknown as KeyboardEvent<HTMLElement>, vi.fn());
    await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());
  });

  it("does not paste native files into a field that lost focus while reading", async () => {
    const target = { isConnected: true };
    const documentState = { activeElement: target };
    let finish!: (files: unknown[]) => void;
    vi.stubGlobal("document", documentState);
    vi.stubGlobal("window", { ohMyGameDesktop: { clipboard: { files: () => new Promise(resolve => { finish = resolve; }), paste: vi.fn() } } });
    const onFiles = vi.fn();
    pasteNativeFiles({ target, metaKey: true, key: "v", nativeEvent: {}, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLElement>, onFiles);
    documentState.activeElement = { isConnected: true };
    finish([{ name: "rules.md", relativePath: "rules.md", bytes: new Uint8Array([1]) }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("waits for in-flight uploads to settle before allowing an upload retry", async () => {
    let finish!: () => void;
    const deferred = new Promise<never>((_resolve, reject) => { finish = () => reject(new Error("still uploading")); });
    const upload = vi.spyOn(api, "uploadProjectAttachment").mockImplementationOnce(async () => { throw new Error("first failed"); }).mockImplementation(() => deferred);
    const attachments = attachmentFiles([new File(["a"], "a.txt"), new File(["b"], "b.txt")]);
    let settled = false;
    const result = uploadAttachments("project", "batch", attachments).catch((cause) => { settled = true; return cause; });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    expect(await result).toEqual(new Error("first failed"));
  });
});
