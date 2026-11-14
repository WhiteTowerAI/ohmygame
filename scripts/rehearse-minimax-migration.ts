// Exercises settings migration on a disposable copy, never on the supplied data.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  inspectMinimaxMigration,
} from "./inspect-minimax-migration.js";

import {
  snapshot,
  same,
  type File,
  type Snapshot,
} from "../src/daemon/minimax-settings-snapshot.js";
import {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  forgetSettingsTransaction,
} from "../src/daemon/minimax-settings-transaction.js";

import { proposeMinimaxSettings } from "../src/daemon/minimax-migration-settings.js";

export async function rehearseMinimaxMigration(dataDirectory: string) {
  const report = {
    version: 1,
    scope: "temporary-settings-copy",
    activation: "held",
    status: "failed" as "passed" | "blocked" | "failed",
    blockers: [] as string[],
    proposed: { keys: 0, providerPreferences: 0, defaultVideoModel: false },
    checks: {
      reload: null as boolean | null,
      idempotent: null as boolean | null,
      rollback: null as boolean | null,
      sourceUnchanged: null as boolean | null,
      cleanup: null as boolean | null,
    },
  };
  let original: Snapshot | undefined,
    staged: string | undefined,
    changes: Snapshot | undefined;
  let stage = "read-source";
  try {
    original = await snapshot(dataDirectory);
    stage = "copy-settings";
    // POSIX: mkdtemp creates a 0700 directory and every written file is 0600.
    staged = await mkdtemp(path.join(tmpdir(), "ohmygame-minimax-rehearsal-"));
    for (const [file, bytes] of original)
      if (bytes !== undefined) await write(staged, file, bytes);
    stage = "inspect-copy";
    const before = await inspectMinimaxMigration(staged);
    if (before.blockers.length) {
      report.status = "blocked";
      report.blockers = before.blockers;
    } else {
      const plan = proposeMinimaxSettings(original, before);
      changes = plan.changes;
      report.proposed = plan.counts;
      stage = "apply-copy";
      await prepareSettingsTransaction(staged, original, changes);
      await resumeSettingsTransaction(staged);
      stage = "reload-copy";
      const after = await inspectMinimaxMigration(staged);
      report.checks.reload = after.blockers.length === 0;
      if (!report.checks.reload)
        throw new Error("Reload rejected staged settings");
      const repeated = proposeMinimaxSettings(await snapshot(staged), after);
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
      await rollbackSettingsTransaction(staged);
      await forgetSettingsTransaction(staged);
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
  file: File,
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { "data-dir": { type: "string" }, help: { type: "boolean" } },
    });
    if (values.help)
      console.log(
        "Usage: bun run rehearse:minimax-migration --data-dir <copied-app-data-directory>",
      );
    else if (!values["data-dir"]) {
      console.error("Required: --data-dir <copied-app-data-directory>");
      process.exitCode = 2;
    } else {
      const report = await rehearseMinimaxMigration(
        path.resolve(values["data-dir"]),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "passed" ? 0 : 1;
    }
  } catch {
    console.error("Invalid rehearsal arguments; see --help.");
    process.exitCode = 2;
  }
}
