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
      try {
        pi.appendEntry(CHECKPOINT_ENTRY, {
          version: 1,
          commit: await snapshot(),
        } satisfies StoredCheckpoint);
      } catch (cause) {
        // An entry without a commit says that this message has no checkpoint. A message that replaces an edited
        // one comes right after that one's checkpoint entry, and without this it would be read as its own.
        try {
          pi.appendEntry(CHECKPOINT_ENTRY, { version: 1 });
        } finally {
          // Pi reports extension errors but does not stop the run. The host
          // must latch the failure even when recording the empty entry fails.
          onFailure?.(cause);
        }
        throw cause;
      }
    });
  };
}
