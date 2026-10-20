import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeHttpExecutor } from "builder-util/out/nodeHttpExecutor.js";
import { CancellationToken, type ProgressInfo } from "builder-util-runtime";
import type { BlockMap } from "builder-util-runtime/out/blockMapApi.js";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js";
import { expect, it, vi } from "vitest";

class LocalExecutor extends NodeHttpExecutor {
  override createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) {
    return request({ ...options, agent: false }, callback);
  }
}

it.each(["multipart", "multipart-stalled", "copy-and-single"] as const)(
  "reconstructs a %s update through a CDN with bounded ranges and whole-download progress",
  async (mode) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-update-ranges-"),
    );
    const multipart = mode !== "copy-and-single";
    const count = multipart ? 749 : 194;
    const oldBlocks = Array.from({ length: count }, (_, index) =>
      Buffer.alloc(32, index % 251),
    );
    const order = Array.from({ length: count }, (_, index) =>
      multipart ? index : count - index - 1,
    );
    const changed = (index: number) =>
      multipart ? index % 2 === 1 : index === count - 1;
    const newBlocks = order.map((oldIndex, index) =>
      changed(index) ? Buffer.alloc(32, 255) : oldBlocks[oldIndex]!,
    );
    const target = Buffer.concat(newBlocks);
    const blockmap = (checksums: string[]): BlockMap => ({
      version: "2",
      files: [
        { name: "file", offset: 0, checksums, sizes: checksums.map(() => 32) },
      ],
    });
    const oldMap = blockmap(oldBlocks.map((_, index) => `old-${index}`));
    const newMap = blockmap(
      order.map((oldIndex, index) =>
        changed(index) ? `new-${index}` : `old-${oldIndex}`,
      ),
    );
    const requests: number[] = [];
    let transferred = 0;
    let releaseBatch: (() => void) | undefined;
    let secondBatchStarted!: () => void;
    const secondBatch = new Promise<void>((resolve) => {
      secondBatchStarted = resolve;
    });
    const server = createServer((req, response) => {
      const ranges = req.headers.range
        ?.replace(/^bytes=/, "")
        .split(",")
        .map((range) => range.trim());
      requests.push(ranges?.length ?? 0);
      // Reproduce the observed CDN behavior: an oversized request loses Range.
      if (!ranges || ranges.length > 64) {
        response.writeHead(200, {
          "content-type": "application/zip",
          "accept-ranges": "bytes",
        });
        response.end(target);
        return;
      }
      const parts = ranges.map((range) => {
        const [start, end] = range.split("-").map(Number) as [number, number];
        const bytes = target.subarray(start, end + 1);
        transferred += bytes.length;
        return { start, end, bytes };
      });
      if (parts.length === 1) {
        const part = parts[0]!;
        response.writeHead(206, {
          "content-type": "application/zip",
          "content-range": `bytes ${part.start}-${part.end}/${target.length}`,
        });
        response.end(part.bytes);
        return;
      }
      const boundary = "ohmygame-update-boundary";
      const body = Buffer.concat([
        ...parts.flatMap((part) => [
          Buffer.from(
            `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${part.start}-${part.end}/${target.length}\r\n\r\n`,
          ),
          part.bytes,
          Buffer.from("\r\n"),
        ]),
        Buffer.from(`--${boundary}--\r\n`),
      ]);
      response.writeHead(206, {
        "content-type": `multipart/byteranges; boundary=${boundary}`,
        "content-length": body.length,
      });
      if (mode === "multipart-stalled" && requests.length === 2) {
        releaseBatch = () => response.end(body);
        secondBatchStarted();
      } else response.end(body);
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test server");
      const oldFile = path.join(directory, "old.zip");
      const newFile = path.join(directory, "new.zip");
      await writeFile(oldFile, Buffer.concat(oldBlocks));
      const progress: ProgressInfo[] = [];
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      if (mode === "multipart-stalled")
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const failed = vi.fn();
      const download = new GenericDifferentialDownloader(
        {
          size: target.length,
          sha512: createHash("sha512").update(target).digest("base64"),
        },
        new LocalExecutor(),
        {
          oldFile,
          newFile,
          newUrl: new URL(`http://127.0.0.1:${address.port}/update.zip`),
          logger,
          requestHeaders: null,
          isUseMultipleRangeRequest: true,
          cancellationToken: new CancellationToken(),
          onProgress: (value) => progress.push(value),
        },
      ).download(oldMap, newMap);
      void download.catch(failed);
      if (mode === "multipart-stalled") {
        await secondBatch;
        await vi.advanceTimersByTimeAsync(11_000);
        expect(failed).not.toHaveBeenCalled();
        releaseBatch!();
      }
      await download;
      const expectedDownload = newBlocks.reduce(
        (sum, block, index) => sum + (changed(index) ? block.length : 0),
        0,
      );
      expect(await readFile(newFile)).toEqual(target);
      expect(requests.every((ranges) => ranges > 0 && ranges <= 64)).toBe(true);
      expect(transferred).toBe(expectedDownload);
      expect(progress.at(-1)).toMatchObject({
        total: expectedDownload,
        transferred: expectedDownload,
        percent: 100,
      });
      expect(
        progress.every(
          (value, index) =>
            index === 0 || value.percent >= progress[index - 1]!.percent,
        ),
      ).toBe(true);
      expect(progress.reduce((sum, value) => sum + value.delta, 0)).toBe(
        expectedDownload,
      );
      expect(progress.every((value) => value.total === expectedDownload)).toBe(
        true,
      );
      if (multipart) {
        expect(requests.length).toBeGreaterThan(1);
        expect(
          progress.some((value) => value.percent > 0 && value.percent < 100),
        ).toBe(true);
      }
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
