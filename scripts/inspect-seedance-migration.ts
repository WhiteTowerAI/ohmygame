// Read-only settings inspection; do not construct the application or plugin services.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectSeedanceMigration } from "../src/daemon/seedance-migration-settings.js";
export { inspectSeedanceMigration };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "data-dir": { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: bun run inspect:seedance-migration --data-dir <copied-app-data-directory>",
      );
    } else if (!values["data-dir"]) {
      console.error("Required: --data-dir <copied-app-data-directory>");
      process.exitCode = 2;
    } else {
      const report = await inspectSeedanceMigration(
        path.resolve(values["data-dir"]),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.blockers.length ? 1 : 0;
    }
  } catch {
    // Argument and parser errors may contain secrets. Emit only a fixed message.
    console.error(
      "Inspection failed. Check arguments and use an existing, readable app data directory.",
    );
    process.exitCode = 2;
  }
}
