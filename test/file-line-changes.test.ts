import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrackedWriteTool,
  fileChangeMetadata,
} from "../src/daemon/file-line-changes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("file tool line counts", () => {
  it("counts creation and rewrites against the file that actually existed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ohmygame-write-counts-"));
    roots.push(cwd);
    const tool = createTrackedWriteTool(cwd);
    const ctx = { cwd } as Parameters<typeof tool.execute>[4];
    const first = await tool.execute(
      "create",
      { path: "notes.txt", content: "keep\nold\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(fileChangeMetadata(first.details).lineChanges).toEqual({
      added: 2,
      removed: 0,
    });
    expect(fileChangeMetadata(first.details).fileDiff?.hunks[0]).toEqual([
      { kind: "added", text: "keep", after: 1 },
      { kind: "added", text: "old", after: 2 },
    ]);
    const rewrite = await tool.execute(
      "rewrite",
      { path: "notes.txt", content: "keep\nnew\nextra\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(fileChangeMetadata(rewrite.details).lineChanges).toEqual({
      added: 2,
      removed: 1,
    });
    const same = await tool.execute(
      "same",
      { path: "notes.txt", content: "keep\nnew\nextra\n" },
      undefined,
      undefined,
      ctx,
    );
    expect(fileChangeMetadata(same.details)).toEqual({
      lineChanges: { added: 0, removed: 0 },
      fileDiff: { hunks: [] },
    });
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(
      "keep\nnew\nextra\n",
    );
  });

  it("omits unavailable counts and preserves writes and cancellation", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ohmygame-write-counts-"));
    roots.push(cwd);
    const tool = createTrackedWriteTool(cwd);
    const ctx = { cwd } as Parameters<typeof tool.execute>[4];
    for (const content of ["\u0000binary", "x".repeat(300_000)]) {
      await writeFile(path.join(cwd, "notes.txt"), content);
      expect(
        (
          await tool.execute(
            "rewrite",
            { path: "notes.txt", content: "new\n" },
            undefined,
            undefined,
            ctx,
          )
        ).details,
      ).toBeUndefined();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute(
        "cancel",
        { path: "notes.txt", content: "cancelled" },
        controller.signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("aborted");
    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe("new\n");
  });

  it("counts patch content that resembles a header and excludes actual headers", () => {
    expect(
      fileChangeMetadata({
        patch:
          "--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,2 @@\n--- old\n+++ new\n unchanged\n",
      }).lineChanges,
    ).toEqual({ added: 1, removed: 1 });
  });

  it("reads older Pi numbered diffs and tracks both line numbers across gaps", () => {
    expect(
      fileChangeMetadata({
        diff: "    ...\n  10 keep\n- 11 old\n+ 11 new\n+ 12 extra\n  12 next\n    ...\n- 40 end\n+ 41 done",
      }),
    ).toEqual({
      lineChanges: { added: 3, removed: 2 },
      fileDiff: {
        hunks: [
          [
            { kind: "same", text: "keep", before: 10, after: 10 },
            { kind: "removed", text: "old", before: 11 },
            { kind: "added", text: "new", after: 11 },
            { kind: "added", text: "extra", after: 12 },
            { kind: "same", text: "next", before: 12, after: 13 },
          ],
          [
            { kind: "removed", text: "end", before: 40 },
            { kind: "added", text: "done", after: 41 },
          ],
        ],
      },
    });
    expect(
      fileChangeMetadata({
        diff: "not a diff",
        lineChanges: { added: -1, removed: 0 },
      }),
    ).toEqual({});
  });

  it("bounds previews while counting changes beyond their line and text limits", () => {
    for (const diff of [
      {
        patch: `@@ -0,0 +1,500 @@\n${Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n")}`,
      },
      { diff: `+1 ${"x".repeat(40_000)}\n+2 last` },
    ]) {
      const metadata = fileChangeMetadata(diff);
      const lines = metadata.fileDiff!.hunks.flat();
      expect(metadata.fileDiff?.truncated).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(300);
      expect(
        lines.reduce((count, line) => count + line.text.length, 0),
      ).toBeLessThanOrEqual(32 * 1024);
      expect(metadata.lineChanges).toEqual({
        added: "patch" in diff ? 500 : 2,
        removed: 0,
      });
    }
  });
});
