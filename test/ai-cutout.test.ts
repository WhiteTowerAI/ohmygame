import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAiCutout } from "../src/daemon/ai-cutout.js";

const fetchModel = vi.hoisted(() => vi.fn());
vi.mock("undici/index.js", () => ({ fetch: fetchModel }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ohmygame-ai-cutout-"));
  fetchModel.mockReset();
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

it("rejects a corrupt model without caching it, then allows a download retry", async () => {
  fetchModel.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () => Buffer.from("corrupt model"),
  });
  const cutout = createAiCutout(directory);
  await expect(cutout("unused.png")).rejects.toThrow("checksum mismatch");
  expect(await readdir(directory)).toEqual([]);
  fetchModel.mockResolvedValueOnce({ ok: false, status: 503 });
  await expect(cutout("unused.png")).rejects.toThrow("503");
  expect(fetchModel).toHaveBeenCalledTimes(2);
});

it("shares an in-flight model download between concurrent requests", async () => {
  fetchModel.mockRejectedValueOnce(new Error("Offline"));
  const cutout = createAiCutout(directory);
  const results = await Promise.allSettled([
    cutout("one.png"),
    cutout("two.png"),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(fetchModel).toHaveBeenCalledOnce();
});
