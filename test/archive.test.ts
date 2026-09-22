import fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPluginArchive } from "../src/daemon/publish/archive.js";

describe("publish archives", () => {
  it("creates identical ZIPs in different time zones", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-"));
    await writeFile(path.join(source, "example.txt"), "same content");
    const originalTimeZone = process.env.TZ;

    try {
      process.env.TZ = "UTC";
      const utc = await createPluginArchive(source);
      process.env.TZ = "Asia/Shanghai";
      const shanghai = await createPluginArchive(source);
      expect(shanghai).toEqual(utc);
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it("creates identical Plugin ZIPs from different file modes", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-archive-mode-"));
    await writeFile(path.join(source, "example.txt"), "same content");

    expect(await archiveWithMode(source, 0o100666)).toEqual(await archiveWithMode(source, 0o100644));
  });
});

async function archiveWithMode(source: string, mode: number): Promise<Buffer> {
  const stat = fs.stat.bind(fs);
  const mocked = vi.spyOn(fs, "stat").mockImplementation(((...args: unknown[]) => {
    const target = args[0] as fs.PathLike;
    const callback = args.at(-1) as (error: NodeJS.ErrnoException | null, stats?: fs.Stats) => void;
    stat(target, (error, stats) => {
      if (error) callback(error);
      else callback(null, Object.assign(stats, { mode }));
    });
  }) as typeof fs.stat);
  try {
    return await createPluginArchive(source);
  } finally {
    mocked.mockRestore();
  }
}
