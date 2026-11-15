import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// A permanent, empty file: deleting/replacing it could let two processes lock
// different inodes. SQLite supplies OS-backed locks, not heartbeat expiry.
export const PROFILE_OWNERSHIP_FILE = ".ohmygame-owner-v1.sqlite";

/** Cooperating daemon processes must own both directories before loading settings. */
export function acquireProfileOwnership(
  directories: readonly string[],
): () => void {
  const owners: DatabaseSync[] = [];
  const seen = new Set<string>();
  const release = () => {
    for (const owner of owners) if (owner.isOpen) owner.close();
  };
  try {
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const canonical = realpathSync(directory);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const file = path.join(canonical, PROFILE_OWNERSHIP_FILE);
      try {
        // Never open and close an existing lock with fs APIs: on POSIX that
        // could release SQLite's locks in this process. Only SQLite opens it.
        closeSync(openSync(file, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = lstatSync(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== 0
      )
        throw new Error(
          `Invalid profile ownership file; leave it intact and check the data directory: ${file}`,
        );
      // Simultaneous BEGINs briefly take shared read locks before one becomes
      // exclusive. Give that handoff a bounded wait instead of rejecting both.
      const owner = new DatabaseSync(file, { timeout: 1_000 });
      owners.push(owner);
      try {
        // No schema/data writes and no journal. The OS releases this transaction
        // on process exit, including a crash; a paused process keeps its lock.
        owner.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        if ((error as { errcode?: number }).errcode === 5)
          throw new Error(
            `OhMyGame data directory is already in use. Close the other instance before starting: ${canonical}`,
            { cause: error },
          );
        throw error;
      }
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
