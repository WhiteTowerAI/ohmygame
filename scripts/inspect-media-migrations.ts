// Offline preflight: source files are read only; rehearsals own disposable copies.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { snapshot, same } from "../src/daemon/media-settings-snapshot.js";
import * as minimax from "../src/daemon/minimax-settings-transaction.js";
import * as seedance from "../src/daemon/seedance-settings-transaction.js";
import * as elevenlabs from "../src/daemon/elevenlabs-settings-transaction.js";
import * as doubao from "../src/daemon/doubao-settings-transaction.js";
import { FILES as minimaxFiles } from "../src/daemon/minimax-settings-snapshot.js";
import { FILES as seedanceFiles } from "../src/daemon/seedance-settings-snapshot.js";
import { FILES as elevenlabsFiles } from "../src/daemon/elevenlabs-settings-snapshot.js";
import { FILES as doubaoFiles } from "../src/daemon/doubao-settings-snapshot.js";
import {
  model3DSettingsTransaction,
  model3DTransactionFiles,
} from "../src/daemon/model3d-settings-transaction.js";
import { rehearseMinimaxMigration } from "./rehearse-minimax-migration.js";
import { rehearseSeedanceMigration } from "./rehearse-seedance-migration.js";
import { rehearseElevenLabsMigration } from "./rehearse-elevenlabs-migration.js";
import { rehearseDoubaoMigration } from "./rehearse-doubao-migration.js";
import { rehearseModel3DMigration } from "./rehearse-model3d-migration.js";
import { inspectMinimaxWorkspaces } from "./inspect-minimax-workspaces.js";
import { MINIMAX_MIGRATION_REGIONS } from "../src/daemon/minimax-migration-settings.js";

const providers = [
  "minimax",
  "seedance",
  "elevenlabs",
  "doubao",
  "meshy",
  "tripo",
] as const;
type Provider = (typeof providers)[number];
const transactions = { minimax, seedance, elevenlabs, doubao };
// Hyper3D cannot activate, but an interrupted preparation still owns shared files.
const records = [
  ...Object.entries(transactions).map(([provider, transaction]) => ({
    provider,
    journal: transaction.SETTINGS_TRANSACTION_FILE,
    backup: transaction.SETTINGS_TRANSACTION_BACKUP,
    committed: transaction.hasCommittedSettingsTransaction,
  })),
  ...(["meshy", "tripo", "hyper3d"] as const).map((provider) => ({
    provider,
    journal: `.${provider}-settings-transaction.json`,
    backup: `.${provider}-settings-committed-v1.json`,
    committed: async (directory: string) =>
      Boolean(
        await model3DSettingsTransaction(provider).committedMigration(
          directory,
        ),
      ),
  })),
];
const files = [
  ...new Set([
    ...minimaxFiles,
    ...seedanceFiles,
    ...elevenlabsFiles,
    ...doubaoFiles,
    ...(["meshy", "tripo", "hyper3d"] as const).flatMap(
      model3DTransactionFiles,
    ),
    ...records.flatMap(({ journal, backup }) => [journal, backup]),
  ]),
];
const rehearsals = {
  minimax: rehearseMinimaxMigration,
  seedance: rehearseSeedanceMigration,
  elevenlabs: rehearseElevenLabsMigration,
  doubao: rehearseDoubaoMigration,
  meshy: (directory: string) => rehearseModel3DMigration(directory, "meshy"),
  tripo: (directory: string) => rehearseModel3DMigration(directory, "tripo"),
};
type Rehearsal = Awaited<ReturnType<(typeof rehearsals)[Provider]>>;

export async function inspectMediaMigrations(
  directory: string,
  workspaces: readonly string[] = [],
) {
  const before = await snapshot(directory, files);
  const blockers: string[] = [];
  const committed = new Set<string>();
  // Validate every receipt before using any shared configuration. Never recover here.
  for (const record of records) {
    if (before.get(record.journal) !== undefined)
      blockers.push(`${record.provider}:interrupted-settings-transaction`);
    try {
      if (await record.committed(directory)) committed.add(record.provider);
    } catch {
      blockers.push(`${record.provider}:committed-record-unreadable`);
    }
  }
  const results: Array<{
    provider: Provider;
    status: Rehearsal["status"] | "committed" | "not-run";
    blockers: string[];
    rehearsal?: Rehearsal;
  }> = [];
  // A pending/corrupt receipt affects shared stores, even for another provider.
  const recordsBlocked = blockers.length > 0;
  for (const provider of providers) {
    if (recordsBlocked) {
      results.push({
        provider,
        status: "not-run",
        blockers: ["settings-recovery-required"],
      });
    } else if (committed.has(provider)) {
      // Current keys/defaults may legitimately differ from the sealed migration.
      results.push({ provider, status: "committed", blockers: [] });
    } else {
      try {
        const rehearsal = await rehearsals[provider](directory);
        results.push({
          provider,
          status: rehearsal.status,
          blockers: rehearsal.blockers,
          rehearsal,
        });
        blockers.push(
          ...rehearsal.blockers.map((reason) => `${provider}:${reason}`),
        );
      } catch {
        // Includes missing/mismatched prepared 3D packages. Never print parser errors.
        const reason = "rehearsal-unavailable";
        results.push({ provider, status: "failed", blockers: [reason] });
        blockers.push(`${provider}:${reason}`);
      }
    }
  }
  let minimaxWorkspaces:
    Awaited<ReturnType<typeof inspectMinimaxWorkspaces>> | undefined;
  if (workspaces.length) {
    try {
      minimaxWorkspaces = await inspectMinimaxWorkspaces(
        directory,
        workspaces,
        MINIMAX_MIGRATION_REGIONS,
        ["MiniMax-H3", "MiniMax-H3-Max"],
      );
      blockers.push(
        ...minimaxWorkspaces.blockers.map(
          (reason) => `minimax-workspaces:${reason}`,
        ),
      );
    } catch {
      blockers.push("minimax-workspaces:inspection-failed");
    }
  }
  const sourceUnchanged = await snapshot(directory, files).then(
    (after) => same(before, after, files),
    () => false,
  );
  if (!sourceUnchanged) blockers.push("source-settings-changed");
  return {
    version: 1,
    scope: "temporary-settings-copies",
    activation: "held",
    status: blockers.length ? "blocked" : "passed",
    providers: results,
    workspaces: {
      scope: "minimax-only",
      requested: workspaces.length,
      status: !workspaces.length
        ? "not-requested"
        : minimaxWorkspaces
          ? "inspected"
          : "failed",
      ...(minimaxWorkspaces ? { report: minimaxWorkspaces } : {}),
    },
    sourceUnchanged,
    blockers: [...new Set(blockers)],
    remainingChecks: [
      "live-generation-and-restart-acceptance",
      "installed-package-integrity-enablement-and-grants",
      "other-provider-canvas-references-and-unfinished-jobs",
      "cutover-and-release-authorization",
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "data-dir": { type: "string" },
        workspace: { type: "string", multiple: true },
        help: { type: "boolean" },
      },
    });
    if (values.help)
      console.log(
        "Usage: bun run inspect:media-migrations --data-dir <copied-app-data-directory> [--workspace <copied-project-directory>]...\nRehearses settings on temporary copies; workspace checks cover MiniMax only. No apply or release.",
      );
    else if (!values["data-dir"]) {
      console.error("Required: --data-dir <copied-app-data-directory>");
      process.exitCode = 2;
    } else {
      const report = await inspectMediaMigrations(
        path.resolve(values["data-dir"]),
        values.workspace?.map((workspace) => path.resolve(workspace)),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "passed" ? 0 : 1;
    }
  } catch {
    console.error(
      "Inspection failed. Check arguments and use an existing, readable copied app data directory.",
    );
    process.exitCode = 2;
  }
}
