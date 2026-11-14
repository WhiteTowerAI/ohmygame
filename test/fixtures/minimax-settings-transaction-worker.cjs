// Stop at an actual filesystem boundary; the parent kills this process before recovery.
const fs = require("node:fs/promises");
const path = require("node:path");
const { realpathSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const [directory, action, boundary] = process.argv.slice(2);
const rename = fs.rename,
  rm = fs.rm;
async function checkpointFor(target) {
  let checkpoint = path
    .relative(
      realpathSync(directory),
      path.join(realpathSync(path.dirname(target)), path.basename(target)),
    )
    .split(path.sep)
    .join("/");
  if (checkpoint === ".minimax-settings-transaction.json") {
    try {
      checkpoint = JSON.parse(await fs.readFile(target, "utf8")).phase;
    } catch (error) {
      if (error.code === "ENOENT") checkpoint = "forgotten";
      else throw error;
    }
  }
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
    await import("../../src/daemon/minimax-settings-transaction.ts");
  if (action === "activate") {
    const { acquireProfileOwnership } = await import("../../src/daemon/profile-ownership.ts");
    process.once("exit", acquireProfileOwnership([directory]));
    const { migrateMinimaxSettings } = await import("../../src/daemon/minimax-settings-migration.ts");
    await migrateMinimaxSettings(directory);
  } else if (action === "startup")
    await migration.recoverInterruptedMinimaxSettings(directory);
  else if (action === "commit")
    await migration.commitSettingsTransaction(directory);
  else if (action === "rollback")
    await migration.rollbackSettingsTransaction(directory);
  else await migration.resumeSettingsTransaction(directory);
})().then(
  () => process.exit(0),
  () => process.exit(1),
);
