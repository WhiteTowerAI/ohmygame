import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  ExtensionFactory,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { CheckpointChangeItem } from "../shared/contracts.js";

/** Session entry that records the workspace snapshot taken before the user message that follows it. */
export const CHECKPOINT_ENTRY = "ohmygame-checkpoint";

/** Session entry written after the workspace and the conversation were put back to a checkpoint. */
export const CHECKPOINT_RESTORED_ENTRY = "ohmygame-checkpoint-restored";

/** Session entry written when a turn has ended, with the snapshot that closes it. */
export const TURN_END_ENTRY = "ohmygame-turn-end";

/** Session entry written after the file changes of a turn were taken back. */
export const CHECKPOINT_UNDONE_ENTRY = "ohmygame-checkpoint-undone";

export interface StoredCheckpoint {
  version: 1;
  /** The snapshot in the project's checkpoint store. */
  commit: string;
}

export interface StoredTurnEnd {
  version: 1;
  /** The id of the checkpoint entry taken before the turn's message. */
  checkpoint: string;
  /** The snapshot of the workspace as the turn left it. */
  commit: string;
  /** How many files differ between the two snapshots. */
  files: number;
  /** Immutable file summaries; absent in older sessions. */
  items?: CheckpointChangeItem[];
}

export interface StoredCheckpointUndone {
  version: 1;
  /** The id of the checkpoint entry of the turn that was undone. */
  checkpoint: string;
  /** The snapshot of the workspace as it was just before the undo. */
  previous: string;
  /** How many of the turn's files were left as they are. */
  kept: number;
  /** Undone paths and the snapshot to reapply for each. Empty after a full Reapply. */
  reapply?: Record<string, string>;
}

/** The snapshots a turn's file changes lie between. */
export interface TurnRange {
  before: string;
  after: string;
}

export function parseStoredCheckpoint(
  value: unknown,
): StoredCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<StoredCheckpoint>;
  return data.version === 1 && isCommit(data.commit)
    ? { version: 1, commit: data.commit }
    : undefined;
}

export function parseStoredTurnEnd(value: unknown): StoredTurnEnd | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<StoredTurnEnd>;
  return data.version === 1 &&
    isEntryId(data.checkpoint) &&
    isCommit(data.commit) &&
    isCount(data.files)
    ? {
        version: 1,
        checkpoint: data.checkpoint,
        commit: data.commit,
        files: data.files,
        ...(Array.isArray(data.items) &&
        data.items.length === data.files &&
        data.items.every(isChangeItem)
          ? { items: data.items }
          : {}),
      }
    : undefined;
}

export function parseStoredCheckpointUndone(
  value: unknown,
): StoredCheckpointUndone | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<StoredCheckpointUndone>;
  return data.version === 1 &&
    isEntryId(data.checkpoint) &&
    isCommit(data.previous) &&
    isCount(data.kept) &&
    (data.reapply === undefined ||
      (data.reapply !== null &&
        typeof data.reapply === "object" &&
        !Array.isArray(data.reapply) &&
        Object.values(data.reapply).every(isCommit)))
    ? {
        version: 1,
        checkpoint: data.checkpoint,
        previous: data.previous,
        kept: data.kept,
        ...(data.reapply ? { reapply: data.reapply } : {}),
      }
    : undefined;
}

/**
 * Finds the snapshots around the turn a checkpoint was taken for, among the
 * entries of a session branch. A turn's end is the later entry that names its
 * checkpoint, never simply the entry that comes next: the ends of one run are
 * written together when the run is over. A checkpoint without an end has no
 * range, for example because the app quit during the turn.
 */
export function turnRange(
  entries: readonly SessionEntry[],
  checkpointId: string,
): TurnRange | undefined {
  const index = entries.findIndex((entry) => entry.id === checkpointId);
  const entry = entries[index];
  const checkpoint =
    entry?.type === "custom" && entry.customType === CHECKPOINT_ENTRY
      ? parseStoredCheckpoint(entry.data)
      : undefined;
  if (!checkpoint) return undefined;
  const end = entries
    .slice(index + 1)
    .map((candidate) =>
      candidate.type === "custom" && candidate.customType === TURN_END_ENTRY
        ? parseStoredTurnEnd(candidate.data)
        : undefined,
    )
    .find((candidate) => candidate?.checkpoint === checkpointId);
  return end ? { before: checkpoint.commit, after: end.commit } : undefined;
}

/**
 * Every snapshot that an OhMyGame entry in these session files names, on
 * every branch: a branch the conversation no longer shows is still in the
 * file. The files are read as text, so that none is rewritten in a newer
 * format, and every id anywhere in an entry's data counts, also in a format
 * this version does not know. A line that is not JSON is passed over, as Pi
 * passes it over when it reads the conversation, so nothing can use an entry
 * on it: a write that was cut off, and the entry Pi appended to it after.
 *
 * With `since`, only what an entry written at or after `since.before` names
 * is kept, as clearing the history before that time leaves it. The time of an
 * entry is used, not of the snapshot: a turn begins with the snapshot that
 * the turn before ended with, and that one is older than the turn. An entry
 * that does not say when it was written keeps everything it names.
 * `since.turns` is told when each turn began, for every turn that began
 * before that time, on every branch as well.
 */
export async function referencedSnapshots(
  sessionDirectory: string,
  since?: { before: number; turns?: (taken: number, checkpointId: string) => void },
): Promise<Set<string>> {
  const found = new Set<string>();
  let files: string[];
  try {
    files = (
      await readdir(sessionDirectory, { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(entry.parentPath, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw error;
  }
  for (const file of files) {
    // When each turn began, by the entry of its checkpoint: a turn's end names that entry, which comes before it.
    const beginnings = new Map<string, { taken: number; checkpointId: string }>();
    const read = (line: string): { taken: number; checkpointId: string } | undefined => {
      // Only an entry of OhMyGame's names snapshots. Lines of messages, which can hold whole images, are not parsed.
      if (!line.includes('"ohmygame-')) return;
      let entry: {
        id?: unknown;
        timestamp?: unknown;
        type?: unknown;
        customType?: unknown;
        data?: unknown;
      };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        return;
      }
      if (
        entry?.type !== "custom" ||
        typeof entry.customType !== "string" ||
        !entry.customType.startsWith("ohmygame-")
      )
        return;
      const taken = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      // An entry that does not say when it was written keeps all it names.
      if (!since || !(taken < since.before)) collectCommits(entry.data, found);
      if (!since) return;
      const data = entry.data as {
        commit?: unknown;
        checkpoint?: unknown;
      } | null;
      const began = (id: unknown): { taken: number; checkpointId: string } | undefined => {
        const at = typeof id === "string" ? beginnings.get(id) : undefined;
        return at !== undefined && at.taken < since.before ? at : undefined;
      };
      if (
        entry.customType === CHECKPOINT_ENTRY &&
        typeof entry.id === "string" &&
        typeof data?.commit === "string"
      )
        beginnings.set(entry.id, { taken, checkpointId: entry.id });
      if (entry.customType === TURN_END_ENTRY) return began(data?.checkpoint);
      return;
    };
    // Only a turn that ended can be undone, so only such a turn counts as one that loses it.
    const turn = (text: string) => {
      const taken = read(text);
      if (taken !== undefined) since?.turns?.(taken.taken, taken.checkpointId);
    };
    // A piece at a time: a conversation with many images can be larger than one string may be.
    const decoder = new StringDecoder("utf8");
    let pending: string[] = [];
    for await (const chunk of createReadStream(file, {
      highWaterMark: 64 * 1024,
    }) as AsyncIterable<Buffer>) {
      const pieces = decoder.write(chunk).split("\n");
      if (pieces.length === 1) {
        pending.push(pieces[0]!);
        continue;
      }
      turn(pending.join("") + pieces[0]);
      for (const line of pieces.slice(1, -1)) turn(line);
      pending = [pieces.at(-1)!];
    }
    turn(pending.join("") + decoder.end());
  }
  return found;
}

function collectCommits(value: unknown, found: Set<string>): void {
  if (isCommit(value)) found.add(value);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectCommits(item, found);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isEntryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isChangeItem(value: unknown): value is CheckpointChangeItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CheckpointChangeItem>;
  return (
    typeof item.path === "string" &&
    ["added", "modified", "removed"].includes(item.kind ?? "") &&
    (item.lines === undefined ||
      (isCount(item.lines?.added) && isCount(item.lines?.removed)))
  );
}

/**
 * Pi extension that snapshots the workspace before each user message is
 * acted on. A user message ends before Pi stores it and before any tool
 * runs, whether it was sent, queued, or steered into a running turn, and Pi
 * waits for this handler. The session factory latches a failed snapshot and
 * blocks inference and tools for that run.
 */
export function checkpointExtension(
  snapshot: () => Promise<string>,
  onFailure?: (cause: unknown) => void,
): ExtensionFactory {
  return (pi) => {
    pi.on("message_end", async (event) => {
      if (event.message.role !== "user") return;
      await recordCheckpoint((data) => pi.appendEntry(CHECKPOINT_ENTRY, data), snapshot, onFailure);
    });
  };
}

/**
 * Snapshots the workspace and records it just before a user message is
 * stored. Pi sessions do this from the checkpoint extension; coding agent
 * sessions, which run no Pi extensions, call it themselves at the same point.
 */
export async function recordCheckpoint(
  append: (data: StoredCheckpoint | { version: 1 }) => void,
  snapshot: () => Promise<string>,
  onFailure?: (cause: unknown) => void,
): Promise<void> {
  try {
    append({ version: 1, commit: await snapshot() });
  } catch (cause) {
    // An entry without a commit says that this message has no checkpoint. A message that replaces an edited
    // one comes right after that one's checkpoint entry, and without this it would be read as its own.
    try {
      append({ version: 1 });
    } finally {
      // Pi reports extension errors but does not stop the run. The host
      // must latch the failure even when recording the empty entry fails.
      onFailure?.(cause);
    }
    throw cause;
  }
}
