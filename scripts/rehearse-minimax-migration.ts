// Exercises settings migration on a disposable copy, never on the supplied data.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  inspectMinimaxMigration,
  MINIMAX_MIGRATION_REGIONS,
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

type Json = Record<string, unknown>;

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
      const plan = propose(original, before);
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

/** Called only after the owning stores accepted this exact copied snapshot. */
function propose(
  original: Snapshot,
  inspected: Awaited<ReturnType<typeof inspectMinimaxMigration>>,
) {
  const parse = (file: File, fallback: Json): Json => {
    const bytes = original.get(file);
    return bytes === undefined ? fallback : JSON.parse(bytes.toString("utf8"));
  };
  const keys = parse("minimax.json", { version: 1 });
  const configuration = parse("plugin-store/configuration.json", {
    version: 1,
    plugins: {},
  });
  const preferences = parse("model-visibility.json", {
    version: 1,
    hidden: {},
  });
  const configurationBefore = JSON.stringify(configuration),
    preferencesBefore = JSON.stringify(preferences);
  const counts = { keys: 0, providerPreferences: 0, defaultVideoModel: false };
  for (const region of inspected.regions) {
    const field = MINIMAX_MIGRATION_REGIONS.find(
      ({ source }) => source === region.source,
    )!.field;
    if (region.key === "copy") {
      const plugins = configuration.plugins as Record<string, Json>;
      configuration.plugins = {
        ...plugins,
        "ohmygame/minimax": {
          ...plugins["ohmygame/minimax"],
          [field]: { type: "secret", value: keys[field] },
        },
      };
      counts.keys++;
    }
    if (region.visibility?.action === "copy") {
      const before = JSON.stringify(preferences);
      const hidden = preferences.hidden as Record<string, string[]>;
      if (Object.hasOwn(hidden, region.source))
        preferences.hidden = {
          ...hidden,
          [region.target]: [...hidden[region.source]],
        };
      if (!region.visibility.source.enabled)
        preferences.disabled = [
          ...((preferences.disabled as string[]) ?? []),
          region.target,
        ];
      if (before !== JSON.stringify(preferences)) counts.providerPreferences++;
    }
  }
  if (inspected.defaultVideoModel.action === "map") {
    // Unlike a normal user selection, a provider rename must retain reference metadata.
    preferences.defaultVideoModel = {
      ...(preferences.defaultVideoModel as Json),
      provider: inspected.defaultVideoModel.target,
    };
    counts.defaultVideoModel = true;
  }
  const changes: Snapshot = new Map();
  if (JSON.stringify(configuration) !== configurationBefore)
    changes.set(
      "plugin-store/configuration.json",
      Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`),
    );
  if (JSON.stringify(preferences) !== preferencesBefore)
    changes.set(
      "model-visibility.json",
      Buffer.from(`${JSON.stringify(preferences, null, 2)}\n`),
    );
  return { changes, counts };
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
