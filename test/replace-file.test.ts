import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFile } from "../src/daemon/replace-file.js";

const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe("replaceFile", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("moves the file once Windows stops refusing with %s", async (code) => {
    directory = await mkdtemp(path.join(tmpdir(), "ohmygame-replace-"));
    const temporary = path.join(directory, "job-1.json.tmp"), destination = path.join(directory, "job-1.json");
    await writeFile(destination, "unconfirmed");
    await writeFile(temporary, "task-recorded");
    // A reader of the last save holds it open for the first two tries.
    const move = vi.fn<typeof rename>()
      .mockRejectedValueOnce(busy(code))
      .mockRejectedValueOnce(busy(code))
      .mockImplementation(rename);
    await replaceFile(temporary, destination, { platform: "win32", move });
    expect(move).toHaveBeenCalledTimes(3);
    expect(await readFile(destination, "utf8")).toBe("task-recorded");
  });

  it("keeps the error after Windows refuses six times", async () => {
    const move = vi.fn<typeof rename>().mockRejectedValue(busy("EPERM"));
    await expect(replaceFile("a.tmp", "a", { platform: "win32", move })).rejects.toMatchObject({ code: "EPERM" });
    expect(move).toHaveBeenCalledTimes(6);
  });

  it("does not try again elsewhere, or for another error", async () => {
    const elsewhere = vi.fn<typeof rename>().mockRejectedValue(busy("EPERM"));
    await expect(replaceFile("a.tmp", "a", { platform: "linux", move: elsewhere })).rejects.toMatchObject({ code: "EPERM" });
    expect(elsewhere).toHaveBeenCalledTimes(1);
    const missing = vi.fn<typeof rename>().mockRejectedValue(busy("ENOENT"));
    await expect(replaceFile("a.tmp", "a", { platform: "win32", move: missing })).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing).toHaveBeenCalledTimes(1);
  });
});
