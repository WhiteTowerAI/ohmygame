// Stop at an actual filesystem boundary; the parent kills this process before recovery.
const fs = require("node:fs/promises");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const [directory, action, boundary] = process.argv.slice(2);
const rename = fs.rename,
  rm = fs.rm;
async function checkpointFor(target) {
  let checkpoint = path.relative(directory, target).split(path.sep).join("/");
  if (checkpoint === ".minimax-settings-transaction.json")
    checkpoint = JSON.parse(await fs.readFile(target, "utf8")).phase;
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
    await import("../../scripts/minimax-settings-transaction.ts");
  if (action === "rollback")
    await migration.rollbackSettingsTransaction(directory);
  else await migration.resumeSettingsTransaction(directory);
})().then(
  () => process.exit(0),
  () => process.exit(1),
);
