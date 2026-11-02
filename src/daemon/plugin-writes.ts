import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { writeAtomically } from "./checkpoint-objects.js";
import type { CheckpointStore } from "./checkpoints.js";
import type { ProjectWrites } from "./project-writes.js";
import { writeWorkspaceNotice } from "./workspace-notice.js";

// Plugin writes outside an agent turn: a command, later a panel. A tool an
// agent calls writes inside that turn, between the turn's snapshots, so the
// turn's undo covers it. Anything else gets its own checkpoint before and
// after, runs while the workspace is held for it, and becomes an entry in
// the project's plugin history that can be undone on its own.
//
// What is about to run is written down first. If its second checkpoint or
// its entry then can't be saved (a full disk), or the app stops partway, the
// note stays, and the change is recorded the next time that works: before the
// next plugin write or undo, when the history is opened, and before a turn's
// snapshot. It stands out as recorded late, since what else changed by then
// is part of it.
//
// Native code can still write outside this path, and start programs that
// write later (the Godot editor does). Those writes show in the next
// snapshot; nothing here promises to undo them.

/** Entries past this many are dropped, oldest first, with their snapshots. */
const HISTORY_MAX_ENTRIES = 50;

export interface PluginChange {
  id: string;
  /** `publisher/name`. */
  plugin: string;
  /** What ran, as `command:<id>`. */
  action: string;
  /** The person-facing name of what ran, in English for the agent. */
  title: string;
  before: string;
  after: string;
  changed: string[];
  at: string;
  undone?: boolean;
  /** The command failed after writing these files; they stay as it left them. */
  failed?: string;
  /**
   * Open editors and the running game carry on through this change and its
   * undo, for a file they follow themselves.
   */
  inPlace?: true;
  /** Recorded after the fact, so it may hold other changes made by then. */
  late?: true;
  /** Ran, but not recorded yet, so it can't be undone yet. */
  unrecorded?: true;
}

/** A plugin write that started and isn't in the history yet. */
type PendingChange = Pick<PluginChange, "id" | "plugin" | "action" | "title" | "before" | "at" | "failed" | "inPlace">;

interface History {
  changes: PluginChange[];
  pending?: PendingChange;
}

export class PluginChangeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

// These reach plugin pages, so they name no paths on the computer. The disk being full is the likely cause.
const RECORD_EARLIER = "An earlier plugin change still can't be recorded for Undo, so nothing was changed. Check that the disk has free space, then try again.";
const RECORD_START = "This change can't be recorded for Undo, so nothing was changed. Check that the disk has free space, then try again.";
const RECORD_AFTER = "The change was made, but it couldn't be recorded for Undo yet. Check that the disk has free space; it will then appear in Plugin changes.";

type Project = Pick<ProjectState, "id" | "workspacePath" | "storagePath">;

export interface PluginWritesOptions {
  writes: ProjectWrites;
  checkpoints: CheckpointStore;
  /**
   * Snapshots a project while this module holds its workspace; it must not
   * take the workspace itself.
   */
  snapshot: (project: ProjectState) => Promise<string>;
  /** Whether an agent turn, a job or publishing is using the project. */
  busy: (project: ProjectState) => boolean;
  /** Tells editors to reload the changed paths. */
  announce: (project: ProjectState, version: string, changed: string[]) => void;
}

export class PluginWrites {
  constructor(private readonly options: PluginWritesOptions) {}

  /**
   * Runs a plugin's write as one undoable change. Refused while an agent
   * works in the project, so a turn's undo never takes back a command's
   * writes or the other way round.
   */
  async run<T>(
    project: ProjectState,
    action: Pick<PluginChange, "plugin" | "action" | "title" | "inPlace">,
    operation: () => Promise<T>,
  ): Promise<{ result: T; change?: PluginChange }> {
    // Held from the first snapshot to the notice, so no other write lands in
    // the change and undo never takes back someone else's edit.
    return this.options.writes.exclusive(project.id, async () => {
      this.#assertIdle(project);
      // Each change stands alone, so an earlier one is recorded before this one starts.
      try {
        await this.#settle(project);
      } catch (cause) {
        throw new PluginChangeError(RECORD_EARLIER, 409, cause);
      }
      const before = await this.options.snapshot(project);
      const pending: PendingChange = {
        id: randomUUID(),
        ...action,
        before,
        at: new Date().toISOString(),
      };
      try {
        await this.#updateHistory(project, (history) => ({ ...history, pending }));
      } catch (cause) {
        // Nothing has run yet, so nothing is lost by stopping here.
        throw new PluginChangeError(RECORD_START, 500, cause);
      }
      let outcome: { ok: true; result: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, result: await operation() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      // A command that wrote and then failed still leaves an undoable change.
      const failed = outcome.ok
        ? undefined
        : outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      let change: PluginChange | undefined;
      try {
        change = await this.#record(project, { ...pending, ...(failed === undefined ? {} : { failed }) }, false);
      } catch (cause) {
        // The note stays, so this is recorded later. Why the command failed matters more than this.
        if (!outcome.ok) {
          await this.#updateHistory(project, (history) => ({ ...history, pending: { ...pending, failed: failed! } })).catch(() => {});
          throw outcome.error;
        }
        throw new PluginChangeError(RECORD_AFTER, 500, cause);
      }
      // It's in the history now, so a notice that can't be written isn't a change left unrecorded.
      const told = change ? this.#tellChange(project, change) : Promise.resolve();
      if (!outcome.ok) {
        await told.catch(() => {});
        throw outcome.error;
      }
      await told;
      return { result: outcome.result, ...(change ? { change } : {}) };
    });
  }

  /** Puts a change that has run into the history, in one write with taking its note away. */
  async #record(project: ProjectState, pending: PendingChange, late: boolean): Promise<PluginChange | undefined> {
    const after = await this.options.snapshot(project);
    const changed = (
      await this.options.checkpoints.diff(project, pending.before, after)
    ).map((change) => change.path);
    // Recorded late, it may hold more than the files it follows itself, so it no longer carries on through open editors.
    const { inPlace, ...rest } = pending;
    const change: PluginChange | undefined = changed.length
      ? {
          ...rest,
          ...(inPlace && !late ? { inPlace } : {}),
          after,
          changed,
          at: late ? pending.at : new Date().toISOString(),
          ...(late ? { late: true as const } : {}),
        }
      : undefined;
    await this.#updateHistory(project, ({ changes }) => ({
      changes: change ? [...changes, change].slice(-HISTORY_MAX_ENTRIES) : changes,
    }));
    return change;
  }

  #tellChange(project: ProjectState, change: PluginChange): Promise<void> {
    return this.#tell(
      project,
      change.changed,
      `The ${change.plugin} plugin's "${change.title}" ${change.failed === undefined ? "changed" : "failed after changing"} workspace files outside a conversation.${change.late ? " It was recorded late, so these paths may include other changes." : ""} Inspect them before continuing. Changed workspace paths: ${JSON.stringify(change.changed)}.`,
      change.inPlace,
    );
  }

  /** Records a change left unrecorded. The caller holds the workspace. */
  async #settle(project: ProjectState): Promise<void> {
    const { pending } = await this.#read(project);
    if (!pending) return;
    const change = await this.#record(project, pending, true);
    // It's in the history now, whether or not the notice can be written.
    if (change) await this.#tellChange(project, change).catch(() => {});
  }

  /**
   * Records a change left unrecorded, if it can, before a snapshot the caller
   * holds the workspace for. If it can't, the caller's snapshot finds out why.
   */
  async settle(project: ProjectState): Promise<void> {
    await this.#settle(project).catch(() => {});
  }

  #assertIdle(project: ProjectState) {
    if (this.options.busy(project))
      throw new PluginChangeError(
        "Wait for the agent, generation jobs and publishing to finish first.",
      );
  }

  /** The project's plugin changes, newest first, trying first to record one left unrecorded. */
  async history(project: ProjectState): Promise<PluginChange[]> {
    // A write running now has a note too, and isn't left unrecorded.
    const running = () => this.options.writes.isMutating(project.id);
    if (!running() && (await this.#read(project)).pending && !this.options.busy(project))
      await this.options.writes.exclusive(project.id, () => this.#settle(project)).catch(() => {});
    const { changes, pending } = await this.#read(project);
    return [
      ...(pending && !running()
        ? [{ ...pending, after: pending.before, changed: [], unrecorded: true as const }]
        : []),
      ...changes.reverse(),
    ];
  }

  /**
   * Takes back one change and leaves the rest of the workspace as it is.
   * Refused, with nothing touched, when a file it wrote changed again.
   */
  undo(project: ProjectState, id: string): Promise<PluginChange> {
    return this.options.writes.exclusive(project.id, async () => {
      this.#assertIdle(project);
      // If it still can't be recorded, an older change can be undone anyway, which may free the room it needs.
      await this.settle(project);
      const change = (await this.#read(project)).changes.find(
        (entry) => entry.id === id,
      );
      if (!change) throw new PluginChangeError("No such plugin change", 404);
      if (change.undone)
        throw new PluginChangeError("This change was already undone");
      const result = await this.options.checkpoints.undo(project, {
        before: change.before,
        after: change.after,
      });
      const undone = { ...change, undone: true };
      await this.#updateHistory(project, (history) => ({
        ...history,
        changes: history.changes.map((entry) => (entry.id === id ? undone : entry)),
      }));
      if (result.changed.length)
        await this.#tell(
          project,
          result.changed,
          `The user undid the ${change.plugin} plugin's "${change.title}". Inspect the current files before continuing. Changed workspace paths: ${JSON.stringify(result.changed)}.`,
          change.inPlace,
        );
      return undone;
    });
  }

  /** Snapshots the history names, which pruning keeps. */
  async snapshots(project: Project): Promise<Set<string>> {
    const { changes, pending } = await this.#read(project);
    return new Set([
      ...changes.flatMap((entry) => [entry.before, entry.after]),
      ...(pending ? [pending.before] : []),
    ]);
  }

  async #tell(project: ProjectState, changed: string[], notice: string, inPlace?: boolean) {
    if (inPlace) {
      await writeWorkspaceNotice(project, notice, this.options.writes.version(project.id));
      return;
    }
    const version = this.options.writes.changed(project.id);
    try {
      await writeWorkspaceNotice(project, notice, version);
    } finally {
      this.options.announce(project, version, changed);
    }
  }

  #file(project: Project) {
    return path.join(
      project.storagePath ?? path.join(project.workspacePath, ".data"),
      "plugin-changes.json",
    );
  }

  async #read(project: Project): Promise<History> {
    let text: string;
    try {
      text = await readFile(this.#file(project), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { changes: [] };
      throw error;
    }
    const value = JSON.parse(text) as { changes?: unknown; pending?: Partial<PendingChange> };
    const pending = value.pending;
    return {
      changes: Array.isArray(value.changes)
        ? (value.changes as PluginChange[]).filter(
            (entry) =>
              typeof entry?.id === "string" &&
              typeof entry.before === "string" &&
              typeof entry.after === "string" &&
              Array.isArray(entry.changed),
          )
        : [],
      ...(typeof pending?.id === "string" && typeof pending.before === "string"
        ? { pending: pending as PendingChange }
        : {}),
    };
  }

  /** Callers hold the project's workspace, so the history changes one at a time. */
  async #updateHistory(
    project: Project,
    change: (history: History) => History,
  ): Promise<void> {
    const file = this.#file(project);
    await mkdir(path.dirname(file), { recursive: true });
    await writeAtomically(
      path.dirname(file),
      file,
      `${JSON.stringify({ version: 1, ...change(await this.#read(project)) }, null, 2)}\n`,
    );
  }
}
