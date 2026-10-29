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
}

export class PluginChangeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

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
    action: { plugin: string; action: string; title: string },
    operation: () => Promise<T>,
  ): Promise<{ result: T; change?: PluginChange }> {
    // Held from the first snapshot to the notice, so no other write lands in
    // the change and undo never takes back someone else's edit.
    return this.options.writes.exclusive(project.id, async () => {
      this.#assertIdle(project);
      const before = await this.options.snapshot(project);
      let outcome: { ok: true; result: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, result: await operation() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      // A command that wrote and then failed still leaves an undoable change.
      const after = await this.options.snapshot(project);
      const changed = (
        await this.options.checkpoints.diff(project, before, after)
      ).map((change) => change.path);
      let change: PluginChange | undefined;
      if (changed.length) {
        change = {
          id: randomUUID(),
          ...action,
          before,
          after,
          changed,
          at: new Date().toISOString(),
          ...(outcome.ok
            ? {}
            : {
                failed:
                  outcome.error instanceof Error
                    ? outcome.error.message
                    : String(outcome.error),
              }),
        };
        await this.#update(project, (entries) =>
          [...entries, change!].slice(-HISTORY_MAX_ENTRIES),
        );
        await this.#tell(
          project,
          changed,
          `The ${action.plugin} plugin's "${action.title}" ${outcome.ok ? "changed" : "failed after changing"} workspace files outside a conversation. Inspect them before continuing. Changed workspace paths: ${JSON.stringify(changed)}.`,
        );
      }
      if (!outcome.ok) throw outcome.error;
      return { result: outcome.result, ...(change ? { change } : {}) };
    });
  }

  #assertIdle(project: ProjectState) {
    if (this.options.busy(project))
      throw new PluginChangeError(
        "Wait for the agent, generation jobs and publishing to finish first.",
      );
  }

  /** The project's plugin changes, newest first. */
  async history(project: Project): Promise<PluginChange[]> {
    return (await this.#read(project)).reverse();
  }

  /**
   * Takes back one change and leaves the rest of the workspace as it is.
   * Refused, with nothing touched, when a file it wrote changed again.
   */
  undo(project: ProjectState, id: string): Promise<PluginChange> {
    return this.options.writes.exclusive(project.id, async () => {
      this.#assertIdle(project);
      const change = (await this.#read(project)).find(
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
      await this.#update(project, (entries) =>
        entries.map((entry) => (entry.id === id ? undone : entry)),
      );
      if (result.changed.length)
        await this.#tell(
          project,
          result.changed,
          `The user undid the ${change.plugin} plugin's "${change.title}". Inspect the current files before continuing. Changed workspace paths: ${JSON.stringify(result.changed)}.`,
        );
      return undone;
    });
  }

  /** Snapshots the history names, which pruning keeps. */
  async snapshots(project: Project): Promise<Set<string>> {
    return new Set(
      (await this.#read(project)).flatMap((entry) => [entry.before, entry.after]),
    );
  }

  async #tell(project: ProjectState, changed: string[], notice: string) {
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

  async #read(project: Project): Promise<PluginChange[]> {
    let text: string;
    try {
      text = await readFile(this.#file(project), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const value = JSON.parse(text) as { changes?: unknown };
    return Array.isArray(value.changes)
      ? (value.changes as PluginChange[]).filter(
          (entry) =>
            typeof entry?.id === "string" &&
            typeof entry.before === "string" &&
            typeof entry.after === "string" &&
            Array.isArray(entry.changed),
        )
      : [];
  }

  /** Callers hold the project's exclusive write, so the history changes one at a time. */
  async #update(
    project: Project,
    change: (entries: PluginChange[]) => PluginChange[],
  ): Promise<void> {
    const file = this.#file(project);
    await mkdir(path.dirname(file), { recursive: true });
    await writeAtomically(
      path.dirname(file),
      file,
      `${JSON.stringify({ version: 1, changes: change(await this.#read(project)) }, null, 2)}\n`,
    );
  }
}
