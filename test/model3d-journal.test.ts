import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    const stored = JSON.parse(await readFile(path.join(directory, "shared.json"), "utf8"));
    expect(stored.version).toBe(1);
    expect(Object.keys(stored)).toEqual(["version", "preview", "refine"]);
    if (process.platform !== "win32")
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

  it.each([
    "[]", "null", "42", '{"private-canary',
    JSON.stringify({ version: 2, entries: {} }),
    JSON.stringify({ version: 1, entries: {}, future: "private-canary" }),
    JSON.stringify({ version: 1, entries: [] }),
    JSON.stringify({ generate: { fingerprint: "private-canary" } }),
    JSON.stringify({ generate: { fingerprint: "a".repeat(64), credentials: {} } }),
    JSON.stringify({ generate: { fingerprint: "a".repeat(64), credentials: { taskId: 42 } } }),
    JSON.stringify({ generate: { fingerprint: "a".repeat(64), credentials: { taskId: "" } } }),
    JSON.stringify({ generate: { fingerprint: "a".repeat(64), future: "private-canary" } }),
  ])("refuses unreadable or unsupported records without a paid call or write (%#)", async (raw) => {
    const { directory, first } = await journals();
    const file = path.join(directory, "shared.json");
    await writeFile(file, raw);
    const create = vi.fn().mockResolvedValue({ taskId: "new-paid-task" });
    await expect(first.submitted("generate", "connection", {}, create)).rejects.toMatchObject({
      statusCode: 409,
      message: "The 3D task record is unreadable or unsupported. It was left unchanged; no new task was submitted.",
    });
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readdir(directory)).toEqual(["shared.json"]);
  });

  it.each([true, false])("migrates an old %s confirmed stage without changing its ownership", async (confirmed) => {
    const { directory, first, second } = await journals();
    const fingerprint = createHash("sha256").update("original").update(JSON.stringify({ prompt: "Tower" })).digest("hex");
    const entry = { fingerprint, ...(confirmed ? { credentials: { taskId: "paid-preview" } } : {}) };
    const entries = { generate: entry, other: { fingerprint: "b".repeat(64), credentials: { uuid: "paid-other", subscriptionKey: "private-canary" } } };
    const file = path.join(directory, "shared.json");
    await writeFile(file, JSON.stringify(entries));
    const create = vi.fn();
    const resume = () => first.submitted("generate", "original", { prompt: "Tower" }, create);
    if (confirmed) await expect(resume()).resolves.toEqual(entry.credentials);
    else await expect(resume()).rejects.toThrow("could not be confirmed");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, ...entries });
    await expect(second.submitted("generate", "changed", { prompt: "Tower" }, create)).rejects.toThrow("connection or input changed");
    const upgraded = await readFile(file, "utf8");
    if (confirmed) await expect(resume()).resolves.toEqual(entry.credentials);
    else await expect(resume()).rejects.toThrow("could not be confirmed");
    expect(await readFile(file, "utf8")).toBe(upgraded);
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous marker when a submission returns invalid credentials", async () => {
    const { directory, first, second } = await journals();
    const create = vi.fn().mockResolvedValue({ taskId: "" });
    await expect(first.submitted("generate", "connection", {}, create)).rejects.toThrow("invalid task credentials");
    const entry = JSON.parse(await readFile(path.join(directory, "shared.json"), "utf8")).generate;
    expect(Object.keys(entry)).toEqual(["fingerprint"]);
    await expect(second.submitted("generate", "connection", {}, create)).rejects.toThrow("could not be confirmed");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("treats inherited property names as new stages and rejects invalid stage IDs", async () => {
    const { directory, first, second } = await journals();
    const create = vi.fn().mockResolvedValue({ taskId: "paid" });
    await expect(first.submitted("__proto__", "connection", {}, create)).rejects.toMatchObject({ statusCode: 400 });
    await expect(first.submitted("version", "connection", {}, create)).rejects.toMatchObject({ statusCode: 400 });
    expect(await readdir(directory)).toEqual([]);
    await first.submitted("constructor", "connection", {}, create);
    await expect(second.submitted("constructor", "connection", {}, create)).resolves.toEqual({ taskId: "paid" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
