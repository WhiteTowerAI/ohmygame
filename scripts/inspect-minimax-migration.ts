// Read-only CLI, including optional workspace/job inspection.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  inspectMinimaxMigration as inspectSettings,
  MINIMAX_MIGRATION_REGIONS,
} from "../src/daemon/minimax-migration-settings.js";
import { inspectMinimaxWorkspaces } from "./inspect-minimax-workspaces.js";
export { MINIMAX_MIGRATION_REGIONS };

export async function inspectMinimaxMigration(
  dataDirectory: string,
  workspaces: readonly string[] = [],
) {
  const report = await inspectSettings(dataDirectory);
  const canvas = workspaces.length
    ? await inspectMinimaxWorkspaces(
        dataDirectory,
        workspaces,
        MINIMAX_MIGRATION_REGIONS,
        ["MiniMax-H3", "MiniMax-H3-Max"],
      )
    : undefined;
  return {
    ...report,
    version: canvas ? 2 : 1,
    scope: canvas ? "selected-workspaces" : "settings-only",
    ...(canvas ? { canvas } : {}),
    blockers: [...report.blockers, ...(canvas?.blockers ?? [])],
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
    if (values.help) {
      console.log(
        "Usage: bun run inspect:minimax-migration --data-dir <copied-app-data-directory> [--workspace <copied-project-directory>]...",
      );
    } else if (!values["data-dir"]) {
      console.error(
        "Required: --data-dir <copied-app-data-directory> [--workspace <copied-project-directory>]...",
      );
      process.exitCode = 2;
    } else {
      const report = await inspectMinimaxMigration(
        path.resolve(values["data-dir"]),
        values.workspace?.map((workspace) => path.resolve(workspace)),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.blockers.length ? 1 : 0;
    }
  } catch {
    // JSON and argument errors can contain secrets supplied as input.
    console.error(
      "Inspection failed. Check arguments and use an existing, readable app data directory.",
    );
    process.exitCode = 2;
  }
}
