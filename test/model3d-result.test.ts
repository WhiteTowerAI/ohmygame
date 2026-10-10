import { describe, expect, it, vi } from "vitest";
import { readModel3DResult } from "../src/daemon/model3d.js";

describe("3D artifact downloads", () => {
  it("assembles streamed chunks in order and releases the reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    await expect(readModel3DResult(new Response(stream))).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(stream.locked).toBe(false);
  });

  it("cancels an oversized declared body without reading it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: { "content-length": String(100 * 1024 * 1024 + 1) } });
    await expect(readModel3DResult(response)).rejects.toMatchObject({ statusCode: 413 });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each([undefined, "1"])("bounds the stream even when content-length is %s", async (length) => {
    // Reuse one chunk so the test never allocates a complete oversized artifact.
    const chunk = new Uint8Array(1024 * 1024);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(chunk));
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: length ? { "content-length": length } : {} });
    await expect(readModel3DResult(response)).rejects.toMatchObject({ statusCode: 413 });
    expect(pull).toHaveBeenCalledTimes(101);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each([null, ""])("rejects an empty artifact instead of saving it", async (body) => {
    await expect(readModel3DResult(new Response(body))).rejects.toMatchObject({
      message: "Generated model download is empty", statusCode: 502,
    });
  });

  it("releases the reader when a download fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("connection interrupted")); },
    });
    await expect(readModel3DResult(new Response(stream))).rejects.toThrow("connection interrupted");
    expect(stream.locked).toBe(false);
  });
});
