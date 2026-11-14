// Stop at an actual filesystem boundary; the parent kills this process before recovery.
const fs = require("node:fs/promises");
const path = require("node:path");
const { realpathSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const [directory, action, boundary, vendor = "minimax"] = process.argv.slice(2);
let lastCheckpoint = "starting";
const rename = fs.rename,
  rm = fs.rm;
async function checkpointFor(target) {
  let checkpoint = path
    .relative(
      // Activation uses fs.promises.realpath (native). Match it for Windows
      // 8.3 temporary-directory aliases as well as macOS /var aliases.
      realpathSync.native(directory),
      path.join(
        realpathSync.native(path.dirname(target)),
        path.basename(target),
      ),
    )
    .split(path.sep)
    .join("/");
  if (checkpoint === `.${vendor}-settings-transaction.json`) {
    try {
      checkpoint = JSON.parse(await fs.readFile(target, "utf8")).phase;
    } catch (error) {
      if (error.code === "ENOENT") checkpoint = "forgotten";
      else throw error;
    }
  }
  lastCheckpoint = checkpoint;
  if (checkpoint === boundary) {
    setInterval(() => {}, 1000);
    process.send({ checkpoint });
    await new Promise(() => {});
  }
}
fs.rename = async (...args) => {
  await rename(...args);
  await checkpointFor(String(args[1]));
};
fs.rm = async (...args) => {
  await rm(...args);
  await checkpointFor(String(args[0]));
};
syncBuiltinESMExports();
(async () => {
  const migration =
    vendor === "seedance"
      ? await import("../../src/daemon/seedance-settings-transaction.ts")
      : await import("../../src/daemon/minimax-settings-transaction.ts");
  if (action === "activate") {
    const { acquireProfileOwnership } =
      await import("../../src/daemon/profile-ownership.ts");
    process.once("exit", acquireProfileOwnership([directory]));
    const { migrateMinimaxSettings } =
      await import("../../src/daemon/minimax-settings-migration.ts");
    const result = await migrateMinimaxSettings(directory);
    if (result.status !== "migrated" && result.status !== "committed")
      throw new Error(
        `Activation ${result.status}: ${result.reasons.join(", ")}`,
      );
  } else if (action === "startup")
    await (
      vendor === "seedance"
        ? migration.recoverInterruptedSeedanceSettings
        : migration.recoverInterruptedMinimaxSettings
    )(directory);
  else if (action === "commit")
    await migration.commitSettingsTransaction(directory);
  else if (action === "rollback")
    await migration.rollbackSettingsTransaction(directory);
  else await migration.resumeSettingsTransaction(directory);
  if (boundary !== "none")
    throw new Error(
      `Completed without checkpoint ${boundary}; last: ${lastCheckpoint}`,
    );
})().then(
  () => process.exit(0),
  (error) => {
    const failure = error instanceof Error ? error.stack : String(error);
    if (process.send) process.send({ failure }, () => process.exit(1));
    else {
      console.error(failure);
      process.exit(1);
    }
  },
);
