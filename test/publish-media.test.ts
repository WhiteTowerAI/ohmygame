import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compressPublishPng,
  PublishMediaOptimizer,
} from "../src/daemon/publish/media.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.resetAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("publish media optimization", () => {
  it("preserves PNG pixels, transparency and ancillary metadata", async () => {
    const png = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.5 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const text = Buffer.from("Author\0Game Creator");
    const chunk = Buffer.alloc(text.length + 12);
    chunk.writeUInt32BE(text.length);
    chunk.write("tEXt", 4);
    text.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const original = Buffer.concat([
      png.subarray(0, 33),
      chunk,
      png.subarray(33),
    ]);
    const compressed = await compressPublishPng(original);
    expect(compressed.length).toBeLessThan(original.length / 10);
    expect(compressed.includes(chunk)).toBe(true);
    expect(
      (await sharp(compressed).raw().toBuffer()).equals(
        await sharp(original).raw().toBuffer(),
      ),
    ).toBe(true);
    expect(
      (await compressPublishPng(original.subarray(0, -1))).equals(
        original.subarray(0, -1),
      ),
    ).toBe(true);
    expect(await compressPublishPng(Buffer.from("bad PNG"))).toEqual(
      Buffer.from("bad PNG"),
    );
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect((await compressPublishPng(corrupt)).equals(corrupt)).toBe(true);
  });

  it("uses a smaller video copy, caches it, and removes it on close", async () => {
    const source = await video();
    const compressed = Buffer.from("encoded MP4");
    mockEncoder(0, compressed);
    const track = vi.fn();
    const optimizer = new PublishMediaOptimizer(track);
    const optimized = await optimizer.optimize(source);
    expect(optimized).not.toBe(source);
    expect(await readFile(optimized)).toEqual(compressed);
    expect((await readFile(source)).length).toBe(512 * 1024);
    expect(await optimizer.optimize(source)).toBe(optimized);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(["0:a?", "libx264", "aac", "+faststart", source]),
    );
    await optimizer.close();
    await expect(readFile(optimized)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["failed", "larger", "empty", "missing-output"] as const)(
    "keeps originals for %s encodes",
    async (mode) => {
      const source = await video();
      mockEncoder(
        mode === "failed" ? 1 : 0,
        mode === "larger"
          ? Buffer.alloc(1024 * 1024)
          : mode === "empty"
            ? Buffer.alloc(0)
            : undefined,
      );
      const optimizer = new PublishMediaOptimizer(() => {});
      try {
        expect(await optimizer.optimize(source)).toBe(source);
      } finally {
        await optimizer.close();
      }
    },
  );

  it("continues publishing without FFmpeg and does not retry a missing encoder for each video", async () => {
    const first = await video();
    const second = await video();
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => {
        child.emit(
          "error",
          Object.assign(new Error("missing"), { code: "ENOENT" }),
        );
        child.emit("close", -2);
      });
      return child;
    });
    const optimizer = new PublishMediaOptimizer(() => {});
    try {
      expect(await optimizer.optimize(first)).toBe(first);
      expect(await optimizer.optimize(second)).toBe(second);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await optimizer.close();
    }
  });

  it("kills a stalled encoder and retains the original", async () => {
    const source = await video();
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    vi.mocked(spawn).mockImplementation(() => {
      started();
      return child;
    });
    const optimizer = new PublishMediaOptimizer(() => {});
    try {
      const result = optimizer.optimize(source);
      await ready;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toBe(source);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      await optimizer.close();
    }
  });
});

async function video(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ohmygame-publish-media-test-"),
  );
  roots.push(root);
  const source = path.join(root, "video.mp4");
  await writeFile(source, Buffer.alloc(512 * 1024));
  return source;
}

function mockEncoder(code: number, output?: Buffer): void {
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = new EventEmitter() as ChildProcess;
    queueMicrotask(() => {
      void (async () => {
        if (output !== undefined)
          await writeFile((args as string[]).at(-1)!, output);
        child.emit("close", code);
      })();
    });
    return child;
  });
}
