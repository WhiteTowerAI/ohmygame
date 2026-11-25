import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { referencedSnapshots } from "../src/daemon/checkpoint-extension.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function sessions(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-checkpoint-references-"),
  );
  roots.push(directory);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  return directory;
}

function lines(...entries: unknown[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

const id = (digit: string) => digit.repeat(40);

describe("snapshots named by session files", () => {
  it("collects every id in OhMyGame entries on every branch of every file", async () => {
    const directory = await sessions({
      "a.jsonl": lines(
        { type: "session", version: 3, id: "a" },
        {
          type: "custom",
          customType: "ohmygame-checkpoint",
          id: "1",
          parentId: null,
          data: { version: 1, commit: id("1") },
        },
        {
          type: "custom",
          customType: "ohmygame-turn-end",
          id: "2",
          parentId: "1",
          data: { version: 1, checkpoint: "1", commit: id("2"), files: 1 },
        },
        // An entry on a branch the conversation left.
        {
          type: "custom",
          customType: "ohmygame-checkpoint",
          id: "3",
          parentId: null,
          data: { version: 1, commit: id("3") },
        },
        {
          type: "custom",
          customType: "ohmygame-checkpoint-undone",
          id: "4",
          parentId: "2",
          data: {
            version: 1,
            checkpoint: "1",
            previous: id("4"),
            kept: 0,
            reapply: { "src/game.ts": id("5") },
          },
        },
        {
          type: "custom",
          customType: "ohmygame-checkpoint-restored",
          id: "5",
          parentId: "4",
          data: { version: 1, checkpoint: "1", undo: id("6") },
        },
        // A format this version does not know still counts.
        {
          type: "custom",
          customType: "ohmygame-checkpoint",
          id: "6",
          parentId: "5",
          data: { version: 2, snapshots: [{ commit: id("7") }] },
        },
        // Entries of others do not.
        {
          type: "custom",
          customType: "other-extension",
          id: "7",
          parentId: "6",
          data: { commit: id("8") },
        },
        {
          type: "message",
          id: "8",
          parentId: "7",
          message: { role: "user", content: id("9") },
        },
      ),
      "nested/b.jsonl": lines({
        type: "custom",
        customType: "ohmygame-turn-end",
        id: "1",
        parentId: null,
        data: { commit: id("a") },
      }),
      "notes.txt": lines({
        type: "custom",
        customType: "ohmygame-checkpoint",
        data: { commit: id("b") },
      }),
    });
    expect([...(await referencedSnapshots(directory))].sort()).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "a"].map(id),
    );
  });

  it("keeps, for a time, what an entry of that time or later names, and tells when the earlier turns began", async () => {
    const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 1, hour, minute)).toISOString();
    const directory = await sessions({
      "a.jsonl": lines(
        // A turn from before the time. Its end wrote the snapshot the next turn begins with.
        { type: "custom", customType: "ohmygame-checkpoint", id: "1", timestamp: at(1), data: { version: 1, commit: id("1") } },
        { type: "custom", customType: "ohmygame-turn-end", id: "2", parentId: "1", timestamp: at(2), data: { version: 1, checkpoint: "1", commit: id("2"), files: 1 } },
        { type: "custom", customType: "ohmygame-checkpoint", id: "3", parentId: "2", timestamp: at(3), data: { version: 1, commit: id("2") } },
        { type: "custom", customType: "ohmygame-turn-end", id: "4", parentId: "3", timestamp: at(4), data: { version: 1, checkpoint: "3", commit: id("4"), files: 1 } },
        // A checkpoint whose turn never ended, and an undo, which is not a turn's end.
        { type: "custom", customType: "ohmygame-checkpoint", id: "5", parentId: "4", timestamp: at(5), data: { version: 1, commit: id("5") } },
        { type: "custom", customType: "ohmygame-checkpoint-undone", id: "6", parentId: "4", timestamp: at(6), data: { version: 1, checkpoint: "3", previous: id("6"), kept: 0 } },
        // An entry on a branch the conversation left, and the end of a turn whose checkpoint entry is not in the file.
        { type: "custom", customType: "ohmygame-checkpoint", id: "7", parentId: null, timestamp: at(0), data: { version: 1, commit: id("7") } },
        { type: "custom", customType: "ohmygame-turn-end", id: "8", parentId: "7", timestamp: at(0, 30), data: { version: 1, checkpoint: "missing", commit: id("8"), files: 1 } },
        // An entry that does not say when it was written.
        { type: "custom", customType: "ohmygame-checkpoint-undone", id: "9", parentId: "6", data: { version: 1, checkpoint: "1", previous: id("9"), kept: 1 } },
      ),
    });
    const before = Date.parse(at(2, 30));
    const turns: number[] = [];
    const kept = await referencedSnapshots(directory, { before, turns: (taken) => { turns.push(taken); } });
    // The older turn's own snapshot goes, and the one its end wrote stays: the later turn begins with it.
    expect([...kept].sort()).toEqual(["9", "2", "4", "5", "6"].map(id).sort());
    // The end whose checkpoint entry is missing tells of no turn, and neither does a checkpoint whose turn never ended.
    expect(turns.sort()).toEqual([Date.parse(at(1))]);
    expect((await referencedSnapshots(directory)).size).toBe(8);
  });

  it("passes over a line that is not JSON, as Pi does, also after a write that was cut off", async () => {
    const directory = await sessions({});
    const manager = SessionManager.create(directory, directory);
    manager.appendCustomEntry("ohmygame-checkpoint", {
      version: 1,
      commit: id("1"),
    });
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "One" }],
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile()!;
    // A write cut off in the middle, and the entry Pi appends to the same line afterwards.
    await writeFile(
      file,
      `${await readFile(file, "utf8")}{"type":"custom","customType":"ohmygame-checkpoint","data":{"commit":"`,
    );
    SessionManager.open(file, directory).appendCustomEntry(
      "ohmygame-checkpoint",
      { version: 1, commit: id("2") },
    );
    SessionManager.open(file, directory).appendCustomEntry(
      "ohmygame-turn-end",
      { version: 1, commit: id("3") },
    );
    // What is found is exactly what the conversation itself can use.
    const readable = SessionManager.open(file, directory)
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom"
          ? [(entry.data as { commit: string }).commit]
          : [],
      );
    expect(readable).toContain(id("3"));
    expect([...(await referencedSnapshots(directory))].sort()).toEqual(
      readable.sort(),
    );
  });

  it("reads the entries as Pi writes them, also on a branch it moved away from", async () => {
    const directory = await sessions({});
    const manager = SessionManager.create(directory, directory);
    manager.appendCustomEntry("ohmygame-checkpoint", {
      version: 1,
      commit: id("1"),
    });
    const first = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "One" }],
      timestamp: Date.now(),
    });
    manager.appendCustomEntry("ohmygame-checkpoint", {
      version: 1,
      commit: id("2"),
    });
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Two" }],
      timestamp: Date.now(),
    });
    manager.branch(first);
    manager.appendCustomEntry("ohmygame-checkpoint-restored", {
      version: 1,
      checkpoint: "x",
      undo: id("3"),
    });
    expect([...(await referencedSnapshots(directory))].sort()).toEqual(
      ["1", "2", "3"].map(id),
    );
  });

  it("finds nothing where there are no sessions", async () => {
    const directory = await sessions({});
    expect(await referencedSnapshots(directory)).toEqual(new Set());
    expect(await referencedSnapshots(path.join(directory, "missing"))).toEqual(
      new Set(),
    );
  });
});
