import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectState, TurnChanges } from "../shared/contracts.js";
import { countLineChanges } from "../shared/line-diff.js";
import { changeText, MAX_CHANGE_BYTES } from "./file-line-changes.js";
import {
  BUFFERED_BYTES,
  FileChangedError,
  CheckpointFileTooLargeError,
  ObjectVerifier,
  SourceError,
  TREE_MODE,
  blobId,
  fileBlobId,
  fromSource,
  initialize,
  readBlobLimited,
  readCommit,
  readCommitTree,
  readHead,
  readObject,
  readTree,
  writeAtomically,
  writeBlobTo,
  writeCommit,
  writeFileBlob,
  writeFileCopyBlob,
  writeHead,
  writeObject,
  writeTree,
  type Commit,
  type TreeEntry,
} from "./checkpoint-objects.js";

type CheckpointProject = Pick<ProjectState, "workspacePath" | "storagePath">;

export interface CheckpointChange {
  /** Workspace path with forward slashes. */
  path: string;
  kind: "added" | "modified" | "removed";
}

export interface CheckpointRestoreResult {
  /** The workspace as it was just before, so `restore` can take the change back. */
  previous: string;
  /** Workspace paths that were written or removed, in path order. */
  changed: string[];
}

export interface CheckpointUndoResult extends CheckpointRestoreResult {
  /**
   * Paths that could not simply be put back, in path order. See `CheckpointStore.undo`. With `"keep"` they were left
   * as they are, and with a list of paths to overwrite they were overwritten.
   */
  conflicts: string[];
}

/** Two snapshots that enclose the changes to undo, such as one Agent turn. */
export interface CheckpointRange {
  before: string;
  after: string;
}

export interface CheckpointUndoOptions {
  /** Restore only these undone paths to their actual pre-undo snapshots. */
  reapply?: Record<string, string>;
  /**
   * What to do with conflicts: leave those paths as they are, or overwrite the ones that are listed. A file that
   * became a conflict after the list was made is not in it, and so refuses the undo. A path that is in the list is
   * overwritten as it is when the undo runs, also when it was saved again meanwhile: `previous` holds it. Without
   * this an undo with conflicts is refused.
   */
  conflicts?: "keep" | { overwrite: readonly string[] };
}

/**
 * A restore or an undo was refused because of these paths. The workspace was not touched. `blocked` are the ones
 * among them that cannot be put back whatever the caller chooses.
 */
export class CheckpointConflictError extends Error {
  constructor(
    readonly conflicts: string[],
    readonly blocked: string[],
  ) {
    super(
      `These files cannot be put back without losing later changes: ${conflicts.join(", ")}`,
    );
  }
}

/**
 * Something else changed this file while a restore or an undo was under way.
 * The file was left as it is, what had already been changed was taken back,
 * and the operation can be tried again.
 */
export class CheckpointChangedError extends Error {
  constructor(readonly path: string) {
    super(
      `The workspace changed while a checkpoint was being put back: ${path}`,
    );
  }
}

/**
 * A restore or an undo failed part way and could not take back all it had changed. `previous` holds the workspace as
 * it was before, or as it was before an earlier restore or undo that never came to an end. `found` holds the
 * workspace as this operation found it. The two differ only after such an earlier one, and what was done to the
 * workspace since then is in `found` alone.
 */
export class CheckpointIncompleteError extends Error {
  constructor(
    readonly previous: string,
    readonly found: string,
    cause: unknown,
  ) {
    super("The workspace is partly changed", { cause });
  }
}

interface FileEntry {
  oid: string;
  mode: string;
}

interface Change {
  path: string;
  /** The file on the side the diff starts from; absent when there is none. */
  from?: FileEntry;
  /** The file on the side the diff leads to; absent when there is none. */
  to?: FileEntry;
}

/** What tells that a file on disk is still the one that was read or written. */
interface FileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
}

/**
 * A file as an operation read or wrote it. One that was changed a moment
 * before can change again without its size or times showing it, so such a
 * file is known again by its content.
 */
interface RecordedFile extends FileSignature {
  unsettled: boolean;
}

type Signatures = Map<string, RecordedFile>;
type StatCache = Map<string, FileSignature & FileEntry>;

interface Snapshot extends Commit {
  commit: string;
  /** Every file the snapshot holds, as the walk saw it. */
  seen: Signatures;
  paths: WorkspacePaths;
}

interface Walk {
  gitdir: string;
  workspace: string;
  started: number;
  cached: StatCache;
  settled: StatCache;
  seen: Signatures;
  paths: WorkspacePaths;
  objects: ObjectVerifier;
  unreadable: string[];
}

interface Comparison {
  changes: Change[];
  omitted: Change[];
}

/** The changes an operation has made so far, and what each file it wrote looked like afterwards. */
interface Progress {
  made: Change[];
  written: Signatures;
}

const STAT_CACHE_FILE = "ohmygame-stat-cache.json";
const UNFINISHED_FILE = "ohmygame-unfinished.json";
const FILE_CONCURRENCY = 16;
const READ_ATTEMPTS = 3;
// A file changed this recently can change again without its size or times showing it: file systems keep times
// no finer than a few milliseconds on Linux and two seconds on FAT. The next snapshot reads it again instead of
// trusting the cache.
const UNSETTLED_MS = 2_000;
// Dependencies and version control are left out wherever they are. Build output and editor caches are left out at
// the workspace root only: a game may keep its own `levels/build/`. The rest of `.data/` is kept, unlike in the
// file tree and in published archives, because asset metadata must go back together with the assets it describes.
// Generation history and Godot's generated cache are not project creative state.
const EXCLUDED_ANYWHERE = new Set(["node_modules", ".git"]);
const EXCLUDED_AT_ROOT = new Set([
  "dist",
  "build",
  "out",
  ".godot",
  ".ohmygame",
  ".ohmygame-install-pending",
  ".data/agent-attachments",
  "canvas/jobs.json",
]);
const TEMPORARY_PREFIX = ".ohmygame-checkpoint-";
const TEMPORARY_SUFFIX = ".tmp";
// A file that is gone by the time it is read is left out of a snapshot: the folder it was listed in changed meanwhile.
const GONE = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
// A file or folder that is there and may not be read, or that another program holds open on Windows, is left out as
// well, and the snapshot names it: otherwise the path would look later like one that was not there.
const UNREADABLE = new Set(["EACCES", "EPERM", "EBUSY"]);

/** The git directory that holds a project's checkpoints. It is outside the workspace and is removed with the project. */
export function checkpointDirectory(project: CheckpointProject): string {
  return path.join(
    project.storagePath ?? path.dirname(project.workspacePath),
    "checkpoints",
  );
}

function excluded(relativePath: string): boolean {
  if (EXCLUDED_AT_ROOT.has(relativePath)) return true;
  const name = path.posix.basename(relativePath);
  // Many file systems ignore case, and there `.Git` is the same folder as `.git`.
  return temporary(name) || EXCLUDED_ANYWHERE.has(name.toLowerCase());
}

/** Whether a name is one this store gives the files it writes before it renames them into place. */
function temporary(name: string): boolean {
  return name.startsWith(TEMPORARY_PREFIX) && name.endsWith(TEMPORARY_SUFFIX);
}

/**
 * Snapshots of a project's workspace in a git object store, so the changes
 * between two snapshots can be shown and undone. The store never uses the
 * workspace's own `.git` or `.gitignore`. Excluded paths are never recorded
 * and never touched. Neither is a path that could not be read when one of the
 * snapshots an operation looks at was taken: each snapshot names those paths.
 *
 * A restore or an undo replaces or removes a file only when a snapshot holds
 * it exactly as it is on disk, so what it overwrites can be had back. The
 * daemon must use one store: operations on a project run one at a time per
 * store.
 */
export class CheckpointStore {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #limit = limiter(FILE_CONCURRENCY);
  readonly #objects = new ObjectVerifier();

  /** Records the workspace as it is now and returns the commit that holds it. */
  snapshot(project: CheckpointProject): Promise<string> {
    return this.#serialize(
      project,
      async () => (await this.#snapshot(project)).commit,
    );
  }

  /**
   * Resolves when no snapshot, restore or undo of the project is under way or
   * waiting in this store. A caller that is about to remove the project waits
   * for it, because an operation that is still running writes to the store.
   * From then on until the folder is gone it must ask for no further one: an
   * operation that starts while the folder is being removed writes into it.
   */
  async settled(project: CheckpointProject): Promise<void> {
    const key = checkpointDirectory(project);
    // An operation that is asked for while this waits is waited for as well.
    for (
      let queued = this.#queues.get(key);
      queued;
      queued = this.#queues.get(key)
    )
      await queued;
  }

  /** Lists the files that differ between two snapshots, in path order. A path that either of them could not read is not listed. */
  async diff(
    project: CheckpointProject,
    from: string,
    to: string,
  ): Promise<CheckpointChange[]> {
    const gitdir = checkpointDirectory(project);
    const { changes } = await this.#compare(
      gitdir,
      await readCommit(gitdir, from),
      await readCommit(gitdir, to),
    );
    return changes
      .map((change): CheckpointChange => ({
        path: change.path,
        kind: !change.from ? "added" : !change.to ? "removed" : "modified",
      }))
      .sort((left, right) => compare(left.path, right.path));
  }

  /** Immutable, bounded text statistics for the end-of-turn summary. */
  async summarize(
    project: CheckpointProject,
    from: string,
    to: string,
  ): Promise<TurnChanges> {
    const items = [];
    const text = async (commit: string, filePath: string) => {
      try {
        return changeText(
          await this.read(project, commit, filePath, MAX_CHANGE_BYTES),
        );
      } catch (cause) {
        if (cause instanceof CheckpointFileTooLargeError) return undefined;
        throw cause;
      }
    };
    for (const change of await this.diff(project, from, to)) {
      const before =
        change.kind === "added" ? "" : await text(from, change.path);
      const after =
        change.kind === "removed" ? "" : await text(to, change.path);
      items.push({
        ...change,
        ...(before !== undefined && after !== undefined
          ? { lines: countLineChanges(before, after) }
          : {}),
      });
    }
    return { files: items.length, items };
  }

  /**
   * Reads a file as a snapshot holds it, or the target of a symbolic link.
   * Undefined when the snapshot has no file there. The whole file is held in
   * memory, so this is for files a diff view would show.
   */
  async read(
    project: CheckpointProject,
    commit: string,
    filePath: string,
    maxBytes?: number,
  ): Promise<Uint8Array | undefined> {
    const gitdir = checkpointDirectory(project);
    let tree = await readCommitTree(gitdir, commit);
    const names = filePath.split("/");
    for (const [index, name] of names.entries()) {
      const entry = (await this.#entries(gitdir, tree)).get(name);
      if (index === names.length - 1)
        return entry && entry.mode !== TREE_MODE
          ? maxBytes === undefined
            ? await readObject(gitdir, entry.oid, "blob")
            : await readBlobLimited(gitdir, entry.oid, maxBytes)
          : undefined;
      if (entry?.mode !== TREE_MODE) return undefined;
      tree = entry.oid;
    }
    return undefined;
  }

  /**
   * The snapshot from before a restore or an undo that never came to an end,
   * for example because the app quit, and so may have left the workspace
   * partly changed. Restoring it puts the workspace back as it was. Undefined
   * when the last restore or undo ran to its end.
   * An unreadable or malformed record is an error, not an absent recovery.
   */
  async unfinished(project: CheckpointProject): Promise<string | undefined> {
    return this.#unfinished(checkpointDirectory(project));
  }

  async #unfinished(gitdir: string): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(path.join(gitdir, UNFINISHED_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const { previous } = JSON.parse(text) as { previous?: unknown };
    if (typeof previous !== "string" || !/^[0-9a-f]{40}$/.test(previous))
      throw new Error("Invalid checkpoint recovery record");
    await readCommit(gitdir, previous);
    return previous;
  }

  /**
   * Puts the whole workspace back to a snapshot. Only files that differ are
   * written or removed. It is refused, with nothing touched, when a file
   * cannot come back because something that is not part of checkpoints, such
   * as a folder of excluded files, is in its place, or because its place cannot be read now.
   * An unfinished operation must be restored to its recorded recovery checkpoint first.
   */
  restore(
    project: CheckpointProject,
    commit: string,
    complete?: (previous: string) => Promise<void>,
  ): Promise<CheckpointRestoreResult> {
    return this.#serialize(project, async () => {
      const recovering = await this.unfinished(project);
      if (recovering && commit !== recovering)
        throw new CheckpointIncompleteError(
          recovering,
          (await this.#snapshot(project)).commit,
          new Error("Recover the unfinished checkpoint operation first"),
        );
      const gitdir = checkpointDirectory(project);
      const target = await readCommit(gitdir, commit);
      const current = await this.#snapshot(project);
      const { changes, omitted } = await this.#compare(gitdir, current, target);
      // A file of the target that is left out, though the target could read its place, is one whose place cannot be read now.
      const missed = unread([target]);
      const unreadable = paths(
        omitted.filter((change) => change.to && !within(change.path, missed)),
      );
      const blocked = [
        ...unreadable,
        ...(await this.#blocked(project, current, changes, [target])),
      ].sort(compare);
      if (blocked.length) throw new CheckpointConflictError(blocked, blocked);
      await this.#apply(project, current, changes, true, complete);
      return { previous: current.commit, changed: paths(changes) };
    });
  }

  /**
   * Takes back the changes between two snapshots and leaves everything else
   * as it is now. A file that is already back as it was is left alone.
   *
   * A file is a conflict when it was changed again afterwards, or when it
   * cannot come back because something that appeared afterwards is in its
   * place. What is in its place is then a conflict as well, under its own
   * path. With conflicts the undo is refused, with nothing touched, unless
   * the caller says to keep those paths as they are or lists every one of
   * them as a path to overwrite. Files that are not part of checkpoints are
   * never removed, so a file they block is refused even then, and so is a
   * file of the range that cannot be read now.
   *
   * A path that one of the two snapshots could not read is not part of the
   * changes between them: what was changed there or below is not taken back,
   * and a file that was moved away from there counts as one that was added.
   */
  undo(
    project: CheckpointProject,
    range: CheckpointRange,
    options: CheckpointUndoOptions = {},
  ): Promise<CheckpointUndoResult> {
    return this.#serialize(project, async () => {
      const unfinished = await this.unfinished(project);
      if (unfinished)
        throw new CheckpointIncompleteError(
          unfinished,
          (await this.#snapshot(project)).commit,
          new Error("Recover the unfinished checkpoint operation first"),
        );
      const gitdir = checkpointDirectory(project);
      const [before, after] = await Promise.all([
        readCommit(gitdir, range.before),
        readCommit(gitdir, range.after),
      ]);
      // The option can come from code without types, and nothing but a list of paths gives leave to overwrite.
      const overwrite =
        options.conflicts &&
        typeof options.conflicts === "object" &&
        Array.isArray(options.conflicts.overwrite)
          ? new Set<string>(options.conflicts.overwrite)
          : undefined;
      const current = await this.#snapshot(project);
      const groups = new Map<string, Set<string>>();
      for (const [file, commit] of Object.entries(options.reapply ?? {})) {
        const scope = groups.get(commit) ?? new Set<string>();
        scope.add(file);
        groups.set(commit, scope);
      }
      const targets = await Promise.all(
        [...groups].map(async ([commit, scope]) => ({
          snapshot: await readCommit(gitdir, commit),
          scope,
        })),
      );
      const protectedCommits = [
        before,
        after,
        ...targets.map((target) => target.snapshot),
      ];
      const plan = async (overwrite: boolean) => {
        const plans = options.reapply
          ? await Promise.all(
              targets.map(({ snapshot, scope }) =>
                this.#undoing(
                  gitdir,
                  snapshot,
                  before,
                  current,
                  overwrite,
                  scope,
                ),
              ),
            )
          : [await this.#undoing(gitdir, before, after, current, overwrite)];
        return {
          changes: [
            ...new Map(
              plans
                .flatMap((plan) => plan.changes)
                .map((change) => [change.path, change]),
            ).values(),
          ],
          changedAgain: [
            ...new Set(plans.flatMap((plan) => plan.changedAgain)),
          ],
          unreadable: [...new Set(plans.flatMap((plan) => plan.unreadable))],
        };
      };
      const { changes, changedAgain, unreadable } = await plan(
        overwrite !== undefined,
      );
      const blocked = [
        ...unreadable,
        ...(await this.#blocked(project, current, changes, protectedCommits)),
      ].sort(compare);
      const conflicts = [...new Set([...changedAgain, ...blocked])].sort(
        compare,
      );
      // Overwriting loses the later state of every conflict, so the caller must have named each of them.
      const refused = overwrite
        ? blocked.length > 0 || conflicts.some((file) => !overwrite.has(file))
        : conflicts.length > 0 && options.conflicts !== "keep";
      if (refused && !overwrite) {
        // What no choice can put back shows only when the conflicts are overwritten: while they are kept, more is in the way.
        const overwriting = await plan(true);
        throw new CheckpointConflictError(
          conflicts,
          [
            ...unreadable,
            ...(await this.#blocked(
              project,
              current,
              overwriting.changes,
              protectedCommits,
            )),
          ].sort(compare),
        );
      }
      if (refused) throw new CheckpointConflictError(conflicts, blocked);
      const applied = changes.filter(
        (change) => !blocked.includes(change.path),
      );
      await this.#apply(project, current, applied, false);
      return { previous: current.commit, changed: paths(applied), conflicts };
    });
  }

  /**
   * Works out from the snapshots alone what an undo changes, which paths were
   * changed again after the range, and which files of the range cannot be
   * read now.
   */
  async #undoing(
    gitdir: string,
    before: Commit,
    after: Commit,
    current: Commit,
    overwrite: boolean,
    scope?: Set<string>,
  ): Promise<{
    changes: Change[];
    changedAgain: string[];
    unreadable: string[];
  }> {
    // What happened since the range is told from all three snapshots, so that nothing one of them could not read is written or removed.
    const [{ changes: ranged }, { changes: since }, { changes: back }] =
      await Promise.all([
        this.#compare(gitdir, before, after),
        this.#compare(gitdir, after, current, [before]),
        this.#compare(gitdir, current, before, [after]),
      ]);
    const inRange = new Set(
      paths(ranged).filter((file) => !scope || scope.has(file)),
    );
    const edited = new Set(paths(since));
    // What it takes to bring the files of the range back; files that are already back are not in it.
    const wanted = back.filter((change) => inRange.has(change.path));

    // A file cannot be written while another file is where one of its folders must be, or below where it must be.
    const present = new Map(
      back
        .filter((change) => change.from)
        .map((change) => [change.path, change]),
    );
    const below = new Map<string, Change[]>();
    for (const change of present.values()) {
      for (const folder of parents(change.path)) {
        const files = below.get(folder);
        if (files) files.push(change);
        else below.set(folder, [change]);
      }
    }
    const obstacles = (change: Change): Change[] =>
      change.to
        ? [
            ...parents(change.path).flatMap(
              (folder) => present.get(folder) ?? [],
            ),
            ...(below.get(change.path) ?? []),
          ]
        : [];

    // An obstacle that the range itself left there goes away with the undo; one that appeared or changed later stays.
    const later = (change: Change): string[] =>
      paths(obstacles(change)).filter((obstacle) => edited.has(obstacle));
    // Such a later file is named under its own path as well: overwriting removes it.
    const changedAgain = [
      ...new Set(
        wanted.flatMap((change) =>
          edited.has(change.path) || later(change).length
            ? [change.path, ...later(change)]
            : [],
        ),
      ),
    ];
    const changes = new Map(
      wanted
        .filter((change) => overwrite || !changedAgain.includes(change.path))
        .map((change) => [change.path, change]),
    );
    // Overwriting a conflict also clears what is in the way of the file that comes back.
    for (const change of [...changes.values()]) {
      for (const obstacle of obstacles(change))
        changes.set(obstacle.path, obstacle);
    }
    const now = unread([current]);
    return {
      changes: [...changes.values()],
      changedAgain,
      unreadable: [...inRange].filter((file) => within(file, now)),
    };
  }

  /**
   * Looks at the workspace before anything in it is changed. Throws when a
   * file to replace or remove is no longer what the snapshot holds. Returns
   * the files that cannot be created because something these changes do not
   * remove is in their place: a file whose name differs only in case on a
   * file system that ignores case, a folder with files that are excluded or
   * that a snapshot could not read, or a place that may not be looked at.
   * `also` are the snapshots the changes were told from beside this one.
   */
  async #blocked(
    project: CheckpointProject,
    current: Snapshot,
    changes: Change[],
    also: Commit[],
  ): Promise<string[]> {
    const workspace = project.workspacePath;
    const unreadable = unread([current, ...also]);
    const removing = new Set<string>();
    await all(
      changes.map(
        async (change) =>
          change.from &&
          (await this.#limit(async () => {
            const stats = await this.#recorded(
              project,
              current.seen,
              change,
              current.paths,
            );
            if (!change.to) removing.add(identity(stats));
          })),
      ),
    );

    const places = new Map<string, Promise<"free" | "folder" | "taken">>();
    const place = (relative: string): Promise<"free" | "folder" | "taken"> => {
      let found = places.get(relative);
      if (!found) {
        found = this.#limit(async () => {
          await current.paths.check(relative);
          const stats = await lstat(path.join(workspace, relative)).catch(
            (error: NodeJS.ErrnoException) => error.code ?? "",
          );
          if (typeof stats === "string")
            return UNREADABLE.has(stats) ? "taken" : "free";
          if (stats.isDirectory()) return "folder";
          return removing.has(identity(stats)) ? "free" : "taken";
        });
        places.set(relative, found);
      }
      return found;
    };
    const blocked: string[] = [];
    await all(
      changes.map(async (change) => {
        if (change.from || !change.to) return;
        for (const folder of parents(change.path)) {
          const found = await place(folder);
          if (found === "taken") blocked.push(change.path);
          if (found !== "folder") return;
        }
        const found = await place(change.path);
        if (
          found === "taken" ||
          (found === "folder" &&
            !(await current.paths.holdsOnly(change.path, removing, unreadable)))
        )
          blocked.push(change.path);
      }),
    );
    return blocked.sort(compare);
  }

  /** Returns the stats of a file that is to be replaced or removed, and throws when it is not the file that was recorded. */
  async #recorded(
    project: CheckpointProject,
    recorded: Signatures,
    change: Change,
    paths: WorkspacePaths,
  ): Promise<Stats> {
    await paths.check(change.path);
    const file = path.join(project.workspacePath, change.path);
    const stats = await present(file);
    const signature = recorded.get(change.path);
    if (
      !stats ||
      !signature ||
      stats.isDirectory() ||
      !sameFile(signature, stats)
    )
      throw new CheckpointChangedError(change.path);
    if (signature.unsettled) {
      const oid = await (
        stats.isSymbolicLink()
          ? readlink(file, { encoding: "buffer" }).then(blobId)
          : fileBlobId(file, stats.size)
      ).catch(() => undefined);
      if (oid !== change.from!.oid)
        throw new CheckpointChangedError(change.path);
    }
    await paths.check(change.path);
    return stats;
  }

  /**
   * Makes the changes. When that fails part way, the ones already made are
   * taken back. `whole` says that the workspace is a snapshot again once the
   * changes are made, as after a restore.
   */
  async #apply(
    project: CheckpointProject,
    current: Snapshot,
    changes: Change[],
    whole: boolean,
    complete?: (previous: string) => Promise<void>,
  ): Promise<void> {
    const gitdir = checkpointDirectory(project);
    const unfinished = path.join(gitdir, UNFINISHED_FILE);
    if (changes.length === 0 && !complete)
      return whole ? await rm(unfinished, { force: true }) : undefined;
    // A note that is there already names the last state that was whole, which the workspace as this operation found
    // it is not. So that note stays as it is, and only a restore that runs to its end removes it.
    const earlier = await this.#unfinished(gitdir);
    const previous = earlier ?? current.commit;
    // Says, until the end is reached, where to go back to if this process does not get there.
    if (!earlier)
      await writeAtomically(gitdir, unfinished, JSON.stringify({ previous }));
    const progress: Progress = { made: [], written: new Map() };
    try {
      await this.#make(
        project,
        changes,
        current.seen,
        progress,
        false,
        current.paths,
      );
      // Keep the recovery checkpoint until the associated conversation rewind
      // has been persisted too. Its failure rolls files back in this operation.
      await complete?.(current.commit);
    } catch (cause) {
      // The content to return to is already in the store, so this needs no room for a new snapshot.
      const inverse = progress.made.map((change): Change => ({
        path: change.path,
        ...(change.to ? { from: change.to } : {}),
        ...(change.from ? { to: change.from } : {}),
      }));
      await this.#make(
        project,
        inverse,
        progress.written,
        { made: [], written: new Map() },
        true,
        current.paths,
      ).catch(() => {
        throw new CheckpointIncompleteError(previous, current.commit, cause);
      });
      if (earlier)
        throw new CheckpointIncompleteError(previous, current.commit, cause);
      await rm(unfinished, { force: true });
      throw cause;
    }
    if (whole || !earlier)
      await rm(unfinished, { force: true }).catch((cause) => {
        throw new CheckpointIncompleteError(previous, current.commit, cause);
      });
  }

  /**
   * Writes and removes workspace files as the changes say and notes each one
   * it makes. A file is replaced or removed only while it is still what
   * `recorded` says. Taking changes back goes on after a failure, to put
   * back as much as can be.
   */
  async #make(
    project: CheckpointProject,
    changes: Change[],
    recorded: Signatures,
    progress: Progress,
    goOn: boolean,
    paths: WorkspacePaths,
  ): Promise<void> {
    const workspace = project.workspacePath;
    const failures: unknown[] = [];
    // Removals go first so a file can take the place of a folder and the other way round.
    for (const change of changes) {
      if (change.to || (failures.length && !goOn)) continue;
      try {
        await this.#recorded(project, recorded, change, paths);
        await rm(path.join(workspace, change.path), { force: true });
        progress.made.push(change);
        await paths.removeEmptyParents(change.path);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length && !goOn) throw failures[0];
    // Nothing is still writing when the changes made are taken back: `all` waits for every write.
    await all(
      changes.map(
        async (change) =>
          change.to &&
          (await this.#limit(async () => {
            await this.#place(project, change, recorded, progress, paths);
          })),
      ),
    ).catch((error: unknown) => {
      failures.push(error);
    });
    if (failures.length) throw failures[0];
  }

  /**
   * Puts one file in place and records the mutation. The content
   * goes to a temporary file beside it first, so a failure never leaves half
   * a file.
   */
  async #place(
    project: CheckpointProject,
    change: Change,
    recorded: Signatures,
    progress: Progress,
    paths: WorkspacePaths,
  ): Promise<void> {
    const gitdir = checkpointDirectory(project);
    const entry = change.to!;
    const file = path.join(project.workspacePath, change.path);
    const replaced = change.from
      ? await this.#recorded(project, recorded, change, paths)
      : undefined;
    await paths.prepare(change.path);
    // The temporary name does not build on the file's own name, which may already be as long as a name can be.
    const beside = path.join(
      path.dirname(file),
      `${TEMPORARY_PREFIX}${randomUUID()}${TEMPORARY_SUFFIX}`,
    );
    try {
      if (entry.mode === "120000") {
        const target = await readObject(gitdir, entry.oid, "blob");
        await paths.check(change.path);
        await symlink(target, beside);
      } else {
        // A file has the permissions of the one it replaces from the start; only whether it can be executed comes from the snapshot.
        const kept = replaced?.isFile() ? replaced.mode & 0o777 : undefined;
        await writeBlobTo(gitdir, entry.oid, beside, kept, () =>
          paths.check(change.path),
        );
        await paths.check(change.path);
        const mode = kept ?? (await lstat(beside)).mode & 0o777;
        await paths.check(change.path);
        await chmod(
          beside,
          entry.mode === "100755"
            ? mode | ((mode & 0o444) >> 2)
            : mode & ~0o111,
        );
      }
      // Writing the content took time, so the place is looked at once more just before it is taken.
      if (change.from) await this.#recorded(project, recorded, change, paths);
      else {
        const existing = await present(file);
        if (existing?.isDirectory()) await paths.removeEmptyTree(change.path);
        else if (existing) throw new CheckpointChangedError(change.path);
      }
      await paths.check(change.path);
      await rename(beside, file);
      // Register the mutation before any fallible bookkeeping. Without a
      // written signature rollback refuses this file and retains recovery.
      progress.made.push(change);
      await paths.check(change.path);
      progress.written.set(change.path, {
        ...signatureOf(await lstat(file)),
        unsettled: true,
      });
    } catch (error) {
      await (async () => {
        await paths.check(change.path);
        await rm(beside, { force: true });
        await paths.removeEmptyParents(change.path);
      })().catch(() => {});
      throw error;
    }
  }

  async #snapshot(project: CheckpointProject): Promise<Snapshot> {
    const gitdir = checkpointDirectory(project);
    // A project that is being removed has no workspace any more, and must not get the folder of its store back.
    // Listing the workspace shows that it is there and that it is a folder.
    await fromSource(readdir(project.workspacePath));
    await initialize(gitdir);
    const paths = await WorkspacePaths.open(project.workspacePath);
    const walk: Walk = {
      gitdir,
      workspace: project.workspacePath,
      started: Date.now(),
      cached: await readStatCache(gitdir),
      settled: new Map(),
      seen: new Map(),
      paths,
      objects: this.#objects,
      unreadable: [],
    };
    const tree =
      (await this.#writeDirectory(walk, "")) ??
      (await writeTree(gitdir, [], walk.objects));
    // The cache is only there for speed, so a failure to write it is not a failure of the snapshot.
    await writeAtomically(
      gitdir,
      path.join(gitdir, STAT_CACHE_FILE),
      JSON.stringify(Object.fromEntries(walk.settled)),
    ).catch(() => {});
    const unreadable = walk.unreadable.sort(compare);
    const head = await readHead(gitdir);
    const recorded = head
      ? await readCommit(gitdir, head).catch(() => undefined)
      : undefined;
    if (
      head &&
      recorded?.tree === tree &&
      recorded.unreadable.join("\0") === unreadable.join("\0")
    )
      return { commit: head, tree, unreadable, seen: walk.seen, paths };
    const commit = await writeCommit(
      gitdir,
      tree,
      recorded ? head : undefined,
      unreadable,
      walk.objects,
    );
    await writeHead(gitdir, commit);
    return { commit, tree, unreadable, seen: walk.seen, paths };
  }

  /**
   * Writes one folder as a tree and returns its id, or undefined when nothing
   * in it is kept. An entry that may not be read is noted, a folder once and
   * under its own path, and left out.
   */
  async #writeDirectory(
    walk: Walk,
    relative: string,
  ): Promise<string | undefined> {
    await walk.paths.directory(relative);
    const names = await this.#limit(() =>
      fromSource(readdir(path.join(walk.workspace, relative))),
    );
    const entries = (
      await all(
        names.map(async (name): Promise<TreeEntry | undefined> => {
          const entryPath = relative ? `${relative}/${name}` : name;
          if (excluded(entryPath)) {
            // What a restore that was cut off left behind. No restore is under way now: operations run one at a time.
            if (temporary(name)) {
              await walk.paths.check(entryPath);
              await rm(path.join(walk.workspace, entryPath), {
                force: true,
              }).catch(() => {});
            }
            return undefined;
          }
          try {
            const file = await this.#limit(async () => {
              await walk.paths.check(entryPath);
              const stats = await fromSource(
                lstat(path.join(walk.workspace, entryPath)),
              );
              if (stats.isDirectory()) {
                walk.paths.record(entryPath, stats);
                return "folder" as const;
              }
              return stats.isFile() || stats.isSymbolicLink()
                ? await this.#writeFile(walk, entryPath, stats)
                : undefined;
            });
            if (file !== "folder") return file && { ...file, name };
            const oid = await this.#writeDirectory(walk, entryPath);
            return oid ? { mode: TREE_MODE, name, oid } : undefined;
          } catch (error) {
            if (!(error instanceof SourceError)) throw error;
            // The workspace is in use: something listed a moment ago, such as a build tool's temporary file, can be gone by now.
            if (GONE.has(error.code ?? "")) return undefined;
            if (!UNREADABLE.has(error.code ?? "")) throw error;
            walk.unreadable.push(entryPath);
            return undefined;
          }
        }),
      )
    ).filter((entry) => entry !== undefined);
    await walk.paths.directory(relative);
    return entries.length
      ? await this.#limit(() => writeTree(walk.gitdir, entries, walk.objects))
      : undefined;
  }

  /** Stores one file or symbolic link and returns its tree entry. A file that changes while it is read is read again. */
  async #writeFile(
    walk: Walk,
    entryPath: string,
    first: Stats,
  ): Promise<FileEntry> {
    const absolute = path.join(walk.workspace, entryPath);
    for (let stats = first, attempt = 1; ; attempt += 1) {
      const mode = stats.isSymbolicLink()
        ? "120000"
        : stats.mode & 0o111
          ? "100755"
          : "100644";
      const cached = walk.cached.get(entryPath);
      let oid =
        cached && cached.mode === mode && sameFile(cached, stats)
          ? cached.oid
          : undefined;
      if (oid && !(await walk.objects.has(walk.gitdir, oid, "blob")))
        oid = undefined;
      if (!oid) {
        try {
          oid = stats.isSymbolicLink()
            ? await writeObject(
                walk.gitdir,
                "blob",
                await fromSource(readlink(absolute, { encoding: "buffer" })),
                walk.objects,
              )
            : await writeFileBlob(
                walk.gitdir,
                absolute,
                stats.size,
                walk.objects,
              );
        } catch (error) {
          if (!(error instanceof FileChangedError)) throw error;
          // After the last attempt a file that does not hold still is recorded from a copy of it.
          if (attempt === READ_ATTEMPTS)
            oid = await writeFileCopyBlob(walk.gitdir, absolute, walk.objects);
        }
        const after = await fromSource(lstat(absolute));
        // A large file was read twice with the same result, which shows well enough that it held still.
        const changed =
          !oid || (stats.size <= BUFFERED_BYTES && !sameFile(stats, after));
        if (attempt < READ_ATTEMPTS && changed) {
          stats = after;
          continue;
        }
      }
      await walk.paths.check(entryPath);
      const signature = signatureOf(stats);
      const unsettled =
        Math.max(stats.mtimeMs, stats.ctimeMs) > walk.started - UNSETTLED_MS;
      walk.seen.set(entryPath, { ...signature, unsettled });
      if (!unsettled)
        walk.settled.set(entryPath, { ...signature, mode, oid: oid! });
      return { mode, oid: oid! };
    }
  }

  /**
   * Compares two snapshots. Every comparison goes through here, because this
   * is where the paths a snapshot could not read are left out: such a path,
   * and everything below it, is not part of a comparison that looks at that
   * snapshot. The snapshot does not tell what was there, so the path must not
   * show as added or removed, and must be neither written nor removed. That
   * holds for the path in whichever spelling: see `folded`. `also` are
   * further snapshots the caller looks at together with these two.
   */
  async #compare(
    gitdir: string,
    from: Commit,
    to: Commit,
    also: Commit[] = [],
  ): Promise<Comparison> {
    const unreadable = unread([from, to, ...also]);
    const comparison: Comparison = { changes: [], omitted: [] };
    for (const change of await this.#diff(gitdir, from.tree, to.tree))
      (within(change.path, unreadable)
        ? comparison.omitted
        : comparison.changes
      ).push(change);
    return comparison;
  }

  /** Collects the files that differ between two trees, for `#compare` alone. Subtrees with the same id are skipped whole. */
  async #diff(
    gitdir: string,
    from: string | undefined,
    to: string | undefined,
    prefix = "",
    changes: Change[] = [],
  ): Promise<Change[]> {
    if (from === to) return changes;
    const [before, after] = await Promise.all([
      this.#entries(gitdir, from),
      this.#entries(gitdir, to),
    ]);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(name);
      const right = after.get(name);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      // Old checkpoints may contain paths that are now excluded.
      if (excluded(entryPath)) continue;
      if (left?.oid === right?.oid && left?.mode === right?.mode) continue;
      const leftTree = left?.mode === TREE_MODE ? left.oid : undefined;
      const rightTree = right?.mode === TREE_MODE ? right.oid : undefined;
      if (leftTree || rightTree)
        await this.#diff(gitdir, leftTree, rightTree, entryPath, changes);
      const leftFile =
        left && !leftTree ? { oid: left.oid, mode: left.mode } : undefined;
      const rightFile =
        right && !rightTree ? { oid: right.oid, mode: right.mode } : undefined;
      if (leftFile || rightFile)
        changes.push({
          path: entryPath,
          ...(leftFile ? { from: leftFile } : {}),
          ...(rightFile ? { to: rightFile } : {}),
        });
    }
    return changes;
  }

  async #entries(
    gitdir: string,
    tree: string | undefined,
  ): Promise<Map<string, TreeEntry>> {
    if (!tree) return new Map();
    return new Map(
      (await readTree(gitdir, tree)).map((entry) => [entry.name, entry]),
    );
  }

  /** Snapshots and changes of one project run one at a time: two conversations may work in it at once. */
  #serialize<T>(
    project: CheckpointProject,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = checkpointDirectory(project);
    const result = (this.#queues.get(key) ?? Promise.resolve()).then(
      operation,
      operation,
    );
    const settled = result.catch(() => {});
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return result;
  }
}

/** Waits for every operation, also after one failed, so that nothing is still running when the failure is reported. */
async function all<T>(operations: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(operations);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function paths(changes: Change[]): string[] {
  return changes.map((change) => change.path).sort(compare);
}

/** The folders a path is in, from the top down. */
function parents(filePath: string): string[] {
  const names = filePath.split("/");
  return names.slice(1).map((_, index) => names.slice(0, index + 1).join("/"));
}

/**
 * One spelling for all the names that a file system may take for the same name: many ignore case, and some how an
 * accented letter is put together. Where a file system tells such names apart, this only leaves more alone.
 */
function folded(filePath: string): string {
  return filePath.normalize("NFC").toLowerCase();
}

/** The paths that these snapshots could not read, spelled as `within` looks for them. */
function unread(snapshots: Commit[]): Set<string> {
  return new Set(
    snapshots.flatMap((snapshot) => snapshot.unreadable.map(folded)),
  );
}

/** Whether a path is one of these places or is below one of them, in whichever spelling. */
function within(filePath: string, places: ReadonlySet<string>): boolean {
  const spelled = folded(filePath);
  return (
    places.has(spelled) || parents(spelled).some((folder) => places.has(folder))
  );
}

function signatureOf(stats: Stats): FileSignature {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    dev: stats.dev,
  };
}

/** A different file or mount invalidates the cache even when size and coarse timestamps match. */
function sameFile(recorded: FileSignature, stats: FileSignature): boolean {
  return (
    recorded.dev === stats.dev &&
    recorded.ino === stats.ino &&
    recorded.size === stats.size &&
    recorded.mtimeMs === stats.mtimeMs &&
    recorded.ctimeMs === stats.ctimeMs
  );
}

function identity(stats: { dev: number; ino: number }): string {
  return `${stats.dev}:${stats.ino}`;
}

/** Checks directory ancestry as well as leaves; a moved directory can keep every leaf's identity. */
class WorkspacePaths {
  readonly #directories = new Map<string, string>();
  readonly #creating = new Map<string, Promise<void>>();

  private constructor(
    readonly workspace: string,
    readonly resolved: string,
  ) {}

  static async open(workspace: string): Promise<WorkspacePaths> {
    const paths = new WorkspacePaths(workspace, await realpath(workspace));
    paths.record("", await lstat(workspace));
    await paths.check("");
    return paths;
  }

  record(relative: string, stats: Stats): void {
    if (!stats.isDirectory()) throw new CheckpointChangedError(relative || ".");
    const recorded = this.#directories.get(relative);
    if (recorded && recorded !== identity(stats))
      throw new CheckpointChangedError(relative || ".");
    this.#directories.set(relative, identity(stats));
  }

  /** Verifies every existing parent, including the root and its resolved location. */
  async check(file: string): Promise<void> {
    const resolved = await realpath(this.workspace).catch(() => undefined);
    if (resolved !== this.resolved)
      throw new CheckpointChangedError(file || ".");
    for (const relative of ["", ...parents(file)])
      await this.#known(relative, file);
  }

  async directory(relative: string): Promise<void> {
    await this.check(relative);
    if (relative) await this.#known(relative, relative);
  }

  async #known(relative: string, file: string): Promise<void> {
    const stats = await present(path.join(this.workspace, relative));
    if (
      !stats?.isDirectory() ||
      (this.#directories.get(relative) ??
        [...this.#directories].find(
          ([name]) => folded(name) === folded(relative),
        )?.[1]) !== identity(stats)
    )
      throw new CheckpointChangedError(file || ".");
  }

  /** Creates parents one at a time, sharing each creation between parallel file writes. */
  async prepare(file: string): Promise<void> {
    await this.check("");
    for (const relative of parents(file)) {
      if (this.#directories.has(relative)) {
        await this.directory(relative);
        continue;
      }
      let creating = this.#creating.get(relative);
      if (!creating) {
        creating = this.#create(relative);
        this.#creating.set(relative, creating);
      }
      try {
        await creating;
      } finally {
        if (this.#creating.get(relative) === creating)
          this.#creating.delete(relative);
      }
    }
    await this.check(file);
  }

  async #create(relative: string): Promise<void> {
    await this.check(relative);
    const target = path.join(this.workspace, relative);
    if (await present(target)) throw new CheckpointChangedError(relative);
    await mkdir(target);
    this.record(relative, await lstat(target));
    await this.directory(relative);
  }

  async holdsOnly(
    relative: string,
    removing: ReadonlySet<string>,
    unreadable: ReadonlySet<string>,
  ): Promise<boolean> {
    await this.directory(relative);
    for (const entry of await readdir(path.join(this.workspace, relative), {
      withFileTypes: true,
    })) {
      const entryPath = `${relative}/${entry.name}`;
      // An excluded file is never removed, even when it is a hard link to an included one.
      if (excluded(entryPath) || within(entryPath, unreadable)) return false;
      if (entry.isDirectory()) {
        if (!(await this.holdsOnly(entryPath, removing, unreadable)))
          return false;
      } else {
        await this.check(entryPath);
        if (
          !removing.has(
            identity(await lstat(path.join(this.workspace, entryPath))),
          )
        )
          return false;
      }
    }
    return true;
  }

  /** Removes only verified empty directories, never traversing a replacement symlink. */
  async removeEmptyTree(relative: string): Promise<void> {
    await this.directory(relative);
    for (const entry of await readdir(path.join(this.workspace, relative), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory())
        await this.removeEmptyTree(`${relative}/${entry.name}`);
    }
    await this.directory(relative);
    await rmdir(path.join(this.workspace, relative));
    this.#directories.delete(relative);
  }

  async removeEmptyParents(file: string): Promise<void> {
    for (const relative of parents(file).reverse()) {
      if (!this.#directories.has(relative)) return;
      await this.directory(relative);
      try {
        await rmdir(path.join(this.workspace, relative));
        this.#directories.delete(relative);
      } catch (error) {
        if (
          ["ENOTEMPTY", "EEXIST", "EACCES", "EPERM"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          return;
        throw error;
      }
    }
  }
}

async function present(target: string): Promise<Stats | undefined> {
  return await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
}

async function readStatCache(gitdir: string): Promise<StatCache> {
  try {
    const entries = Object.entries(
      JSON.parse(
        await readFile(path.join(gitdir, STAT_CACHE_FILE), "utf8"),
      ) as Record<string, FileSignature & FileEntry>,
    );
    return new Map(
      entries.filter(
        ([, entry]) =>
          entry &&
          typeof entry === "object" &&
          [
            entry.size,
            entry.mtimeMs,
            entry.ctimeMs,
            entry.ino,
            entry.dev,
          ].every(Number.isFinite) &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          ["100644", "100755", "120000"].includes(entry.mode) &&
          typeof entry.oid === "string" &&
          /^[0-9a-f]{40}$/.test(entry.oid),
      ),
    );
  } catch {
    // Without the cache every file is read again, which is only slower.
    return new Map();
  }
}

/** Runs at most `limit` operations at a time, however deeply the calls that start them are nested. */
function limiter(
  limit: number,
): <T>(operation: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (operation) => {
    // A finished operation hands its place straight to the next one waiting.
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}
