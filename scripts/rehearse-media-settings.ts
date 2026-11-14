// Exercise an owned disposable copy; never apply to the supplied directory.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Snapshot } from "../src/daemon/media-settings-snapshot.js";

export async function rehearseSettingsMigration<
  File extends string,
  Report extends { blockers: string[] },
  Counts extends Record<string, boolean | number>,
>(
  dataDirectory: string,
  options: {
    name: string;
    snapshot(directory: string): Promise<Snapshot<File>>;
    same(a: Snapshot<File>, b: Snapshot<File>): boolean;
    inspect(directory: string): Promise<Report>;
    propose(
      original: Snapshot<File>,
      inspected: Report,
    ): { changes: Snapshot<File>; counts: Counts };
    emptyCounts: Counts;
    prepare(
      directory: string,
      original: Snapshot<File>,
      changes: Snapshot<File>,
    ): Promise<void>;
    resume(directory: string): Promise<string>;
    rollback(directory: string): Promise<string>;
    forget(directory: string): Promise<void>;
  },
) {
  const {
    snapshot,
    same,
    inspect,
    propose,
    prepare,
    resume,
    rollback,
    forget,
  } = options;
  const report = {
    version: 1,
    scope: "temporary-settings-copy",
    activation: "held",
    status: "failed" as "passed" | "blocked" | "failed",
    blockers: [] as string[],
    proposed: options.emptyCounts,
    checks: {
      reload: null as boolean | null,
      idempotent: null as boolean | null,
      rollback: null as boolean | null,
      sourceUnchanged: null as boolean | null,
      cleanup: null as boolean | null,
    },
  };
  let original: Snapshot<File> | undefined,
    staged: string | undefined,
    changes: Snapshot<File> | undefined;
  let stage = "read-source";
  try {
    original = await snapshot(dataDirectory);
    stage = "copy-settings";
    // POSIX: mkdtemp creates a 0700 directory and every written file is 0600.
    staged = await mkdtemp(
      path.join(tmpdir(), `ohmygame-${options.name}-rehearsal-`),
    );
    for (const [file, bytes] of original)
      if (bytes !== undefined) await write(staged, file, bytes);
    stage = "inspect-copy";
    const before = await inspect(staged);
    if (before.blockers.length) {
      report.status = "blocked";
      report.blockers = before.blockers;
    } else {
      const plan = propose(original, before);
      changes = plan.changes;
      report.proposed = plan.counts;
      stage = "apply-copy";
      await prepare(staged, original, changes);
      await resume(staged);
      stage = "reload-copy";
      const after = await inspect(staged);
      report.checks.reload = after.blockers.length === 0;
      if (!report.checks.reload)
        throw new Error("Reload rejected staged settings");
      const repeated = propose(await snapshot(staged), after);
      report.checks.idempotent = repeated.changes.size === 0;
      if (!report.checks.idempotent)
        throw new Error("Proposal was not idempotent");
      report.status = "passed";
    }
  } catch {
    report.blockers.push(`${stage}-failed`);
    report.status = "failed";
  }
  // All operational failures above are converted to report state before cleanup.
  if (staged && original && changes) {
    try {
      await rollback(staged);
      await forget(staged);
      report.checks.rollback = same(await snapshot(staged), original);
      if (!report.checks.rollback) throw new Error("Rollback differs");
    } catch {
      report.checks.rollback = false;
      report.blockers.push("rollback-copy-failed");
      report.status = "failed";
    }
  }
  if (staged) {
    try {
      await rm(staged, { recursive: true, force: true });
      report.checks.cleanup = true;
    } catch {
      report.checks.cleanup = false;
      report.blockers.push("temporary-cleanup-failed");
      report.status = "failed";
    }
  }
  if (original) {
    try {
      report.checks.sourceUnchanged = same(
        await snapshot(dataDirectory),
        original,
      );
    } catch {
      report.checks.sourceUnchanged = false;
    }
    if (!report.checks.sourceUnchanged) {
      report.blockers.push("source-settings-changed");
      report.status = "failed";
    }
  }
  return report;
}

async function write(
  directory: string,
  file: string,
  bytes: Buffer,
): Promise<void> {
  const location = path.join(directory, file),
    temporary = `${location}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, location);
  } finally {
    await rm(temporary, { force: true });
  }
}
