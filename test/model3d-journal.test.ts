import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { model3DJournal } from "../src/daemon/model3d-journal.js";
import { Model3DGenerationError } from "../src/daemon/model3d.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function journals() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-3d-journal-"));
  directories.push(directory);
  return { directory, first: await model3DJournal(directory, "shared"), second: await model3DJournal(directory, "shared") };
}

describe("shared 3D recovery journals", () => {
  it("reuses stages saved by another instance after both journals were opened", async () => {
    const { directory, first, second } = await journals();
    const create = vi.fn().mockResolvedValue({ taskId: "paid-preview" });
    const preview = await first.submitted("preview", "connection", { prompt: "Tower" }, create);
    expect(await second.submitted("preview", "connection", { prompt: "Tower" }, create)).toEqual(preview);
    const refine = vi.fn().mockResolvedValue({ taskId: "paid-refine" });
    await second.submitted("refine", "connection", preview, refine);
    expect(await first.submitted("refine", "connection", preview, refine)).toEqual({ taskId: "paid-refine" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(await readFile(path.join(directory, "shared.json"), "utf8")))).toEqual(["preview", "refine"]);
    expect((await stat(path.join(directory, "shared.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["shared.json"]);
  });

  it("waits for an in-flight paid submission and reuses its confirmed credentials", async () => {
    const { directory, first, second } = await journals();
    let release!: (value: { taskId: string }) => void;
    const response = new Promise<{ taskId: string }>((resolve) => { release = resolve; });
    const create = vi.fn(() => response);
    const original = first.submitted("preview", "connection", {}, create);
    try {
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const copy = second.submitted("preview", "connection", {}, create);
      // A separate recovery ID must remain free to submit while this one waits.
      const independent = await model3DJournal(directory, "independent");
      await expect(independent.submitted("preview", "connection", {}, async () => ({ taskId: "other" }))).resolves.toEqual({ taskId: "other" });
      release({ taskId: "paid-preview" });
      expect(await Promise.all([original, copy])).toEqual([{ taskId: "paid-preview" }, { taskId: "paid-preview" }]);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      release?.({ taskId: "paid-preview" });
      await original;
    }
  });

  it("preserves concurrently submitted stages in the same journal", async () => {
    const { directory, first, second } = await journals();
    await Promise.all([
      first.submitted("first", "connection", {}, async () => ({ taskId: "paid-1" })),
      second.submitted("second", "connection", {}, async () => ({ taskId: "paid-2" })),
    ]);
    const entries = JSON.parse(await readFile(path.join(directory, "shared.json"), "utf8"));
    expect(entries).toMatchObject({ first: { credentials: { taskId: "paid-1" } }, second: { credentials: { taskId: "paid-2" } } });
  });

  it("rejects a changed fingerprint even in an instance opened before submission", async () => {
    const { first, second } = await journals();
    await first.submitted("preview", "original", {}, async () => ({ taskId: "paid" }));
    const create = vi.fn();
    await expect(second.submitted("preview", "changed", {}, create)).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks a queued retry after an ambiguous submission", async () => {
    const { first, second } = await journals();
    const create = vi.fn().mockRejectedValue(new Error("lost POST response"));
    const results = await Promise.allSettled([
      first.submitted("preview", "connection", {}, create),
      second.submitted("preview", "connection", {}, create),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "lost POST response" } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { statusCode: 409 } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("allows a queued retry after a definite rejection created no paid task", async () => {
    const { first, second } = await journals();
    const create = vi.fn().mockRejectedValueOnce(new Model3DGenerationError("rate limited", 429)).mockResolvedValueOnce({ taskId: "paid" });
    const results = await Promise.allSettled([
      first.submitted("preview", "connection", {}, create),
      second.submitted("preview", "connection", {}, create),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { statusCode: 429 } });
    expect(results[1]).toEqual({ status: "fulfilled", value: { taskId: "paid" } });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
