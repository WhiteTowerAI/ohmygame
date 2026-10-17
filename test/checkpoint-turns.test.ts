import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CHECKPOINT_ENTRY,
  CHECKPOINT_UNDONE_ENTRY,
  TURN_END_ENTRY,
  checkpointExtension,
  parseStoredCheckpoint,
  parseStoredCheckpointUndone,
  parseStoredTurnEnd,
  turnRange,
} from "../src/daemon/checkpoint-extension.js";

const commit = (digit: string) => digit.repeat(40);

function custom(id: string, customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType,
    data,
  };
}

const checkpoint = (id: string, digit: string) =>
  custom(id, CHECKPOINT_ENTRY, { version: 1, commit: commit(digit) });
const end = (id: string, of: string, digit: string, files = 1) =>
  custom(id, TURN_END_ENTRY, {
    version: 1,
    checkpoint: of,
    commit: commit(digit),
    files,
  });
const message = (id: string, role: "user" | "assistant") =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role, content: "" },
  }) as unknown as SessionEntry;

describe("stored turn ends", () => {
  it("reads a turn end and nothing that only looks like one", () => {
    const stored = {
      version: 1,
      checkpoint: "c1",
      commit: commit("a"),
      files: 3,
    };
    expect(parseStoredTurnEnd(stored)).toEqual(stored);
    expect(parseStoredTurnEnd({ ...stored, files: 0, extra: true })).toEqual({
      ...stored,
      files: 0,
    });
    for (const damaged of [
      undefined,
      null,
      "end",
      { ...stored, version: 2 },
      { ...stored, checkpoint: "" },
      { ...stored, checkpoint: 7 },
      { ...stored, commit: "abc" },
      { ...stored, commit: commit("A") },
      { ...stored, files: -1 },
      { ...stored, files: 1.5 },
      { ...stored, files: "3" },
    ])
      expect(parseStoredTurnEnd(damaged)).toBeUndefined();
  });

  it("reads an undo and nothing that only looks like one", () => {
    const stored = {
      version: 1,
      checkpoint: "c1",
      previous: commit("b"),
      kept: 0,
    };
    expect(parseStoredCheckpointUndone(stored)).toEqual(stored);
    for (const reapply of [{ "src/game.ts": commit("c") }, {}]) {
      expect(parseStoredCheckpointUndone({ ...stored, reapply })).toEqual({
        ...stored,
        reapply,
      });
    }
    for (const damaged of [
      undefined,
      [],
      { ...stored, version: 0 },
      { ...stored, checkpoint: undefined },
      { ...stored, previous: commit("b").slice(1) },
      { ...stored, kept: -1 },
      { ...stored, kept: Number.NaN },
      { ...stored, reapply: null },
      { ...stored, reapply: [] },
      { ...stored, reapply: { "src/game.ts": "bad commit" } },
    ])
      expect(parseStoredCheckpointUndone(damaged)).toBeUndefined();
  });
});

describe("checkpointExtension", () => {
  it("reports a snapshot failure to the host even when the failure entry cannot be written", async () => {
    const failure = new Error("snapshot failed");
    const reported = vi.fn();
    let ended!: (event: { message: { role: string } }) => Promise<void>;
    await checkpointExtension(async () => {
      throw failure;
    }, reported)({
      on: (_event: string, handler: typeof ended) => {
        ended = handler;
      },
      appendEntry: () => {
        throw new Error("session write failed");
      },
    } as never);
    await expect(ended({ message: { role: "user" } })).rejects.toThrow(
      "session write failed",
    );
    expect(reported).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("takes a checkpoint before each user message, and writes an entry without a commit when the snapshot fails", async () => {
    const entries: Array<{ customType: string; data: unknown }> = [];
    let ended!: (event: { message: { role: string } }) => Promise<void>;
    const pi = {
      on: (_event: string, handler: typeof ended) => {
        ended = handler;
      },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ customType, data });
      },
    };
    const snapshot = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(commit("a"))
      .mockRejectedValueOnce(new Error("disk full"));
    await checkpointExtension(snapshot)(pi as never);

    await ended({ message: { role: "assistant" } });
    await ended({ message: { role: "user" } });
    await expect(ended({ message: { role: "user" } })).rejects.toThrow(
      "disk full",
    );
    expect(entries).toEqual([
      {
        customType: CHECKPOINT_ENTRY,
        data: { version: 1, commit: commit("a") },
      },
      { customType: CHECKPOINT_ENTRY, data: { version: 1 } },
    ]);
    // Read back, the second entry is no checkpoint; it only keeps an earlier one from being taken for this message's.
    expect(entries.map((entry) => parseStoredCheckpoint(entry.data))).toEqual([
      { version: 1, commit: commit("a") },
      undefined,
    ]);
  });
});

describe("turnRange", () => {
  it("finds the snapshots before and after a turn", () => {
    const branch = [
      checkpoint("c1", "a"),
      message("u1", "user"),
      message("a1", "assistant"),
      end("e1", "c1", "b"),
    ];
    expect(turnRange(branch, "c1")).toEqual({
      before: commit("a"),
      after: commit("b"),
    });
  });

  it("has no range for a turn without an end", () => {
    const branch = [
      checkpoint("c1", "a"),
      message("u1", "user"),
      message("a1", "assistant"),
      checkpoint("c2", "b"),
      message("u2", "user"),
    ];
    expect(turnRange(branch, "c1")).toBeUndefined();
    expect(turnRange(branch, "c2")).toBeUndefined();
  });

  it("does not take an end that comes before the checkpoint", () => {
    const branch = [
      end("e1", "c1", "b"),
      checkpoint("c1", "a"),
      message("u1", "user"),
    ];
    expect(turnRange(branch, "c1")).toBeUndefined();
  });

  it("does not take the end of another turn", () => {
    const branch = [
      checkpoint("c1", "a"),
      message("u1", "user"),
      checkpoint("c2", "b"),
      message("u2", "user"),
      end("e2", "c2", "c"),
    ];
    expect(turnRange(branch, "c1")).toBeUndefined();
    expect(turnRange(branch, "c2")).toEqual({
      before: commit("b"),
      after: commit("c"),
    });
  });

  it("knows only checkpoint entries by their id", () => {
    const branch = [
      checkpoint("c1", "a"),
      message("u1", "user"),
      end("e1", "c1", "b"),
      custom("d1", CHECKPOINT_UNDONE_ENTRY, {
        version: 1,
        checkpoint: "c1",
        previous: commit("c"),
        kept: 0,
      }),
    ];
    expect(turnRange(branch, "missing")).toBeUndefined();
    expect(turnRange(branch, "u1")).toBeUndefined();
    expect(turnRange(branch, "e1")).toBeUndefined();
    expect(turnRange(branch, "d1")).toBeUndefined();
    expect(turnRange([], "c1")).toBeUndefined();
  });

  it("passes over damaged entries", () => {
    const damagedStart = [
      custom("c1", CHECKPOINT_ENTRY, { version: 1, commit: "not a commit" }),
      message("u1", "user"),
      end("e1", "c1", "b"),
    ];
    expect(turnRange(damagedStart, "c1")).toBeUndefined();

    const damagedEnd = [
      checkpoint("c1", "a"),
      message("u1", "user"),
      custom("e1", TURN_END_ENTRY, {
        version: 1,
        checkpoint: "c1",
        commit: commit("b"),
      }),
    ];
    expect(turnRange(damagedEnd, "c1")).toBeUndefined();
    // A later end that can be read still closes the turn.
    expect(turnRange([...damagedEnd, end("e2", "c1", "c")], "c1")).toEqual({
      before: commit("a"),
      after: commit("c"),
    });
  });

  it("gives each turn of a run its own range when the ends are written together", () => {
    // Two messages handled in one run: the first turn ends where the second one starts.
    const branch = [
      checkpoint("c1", "a"),
      message("u1", "user"),
      message("a1", "assistant"),
      checkpoint("c2", "b"),
      message("u2", "user"),
      message("a2", "assistant"),
      end("e1", "c1", "b", 2),
      end("e2", "c2", "c", 1),
      checkpoint("c3", "c"),
      message("u3", "user"),
      message("a3", "assistant"),
      end("e3", "c3", "d", 0),
    ];
    expect(turnRange(branch, "c1")).toEqual({
      before: commit("a"),
      after: commit("b"),
    });
    expect(turnRange(branch, "c2")).toEqual({
      before: commit("b"),
      after: commit("c"),
    });
    expect(turnRange(branch, "c3")).toEqual({
      before: commit("c"),
      after: commit("d"),
    });
  });
});
