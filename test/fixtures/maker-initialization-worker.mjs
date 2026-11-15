// Hold the identity rename until the failing CLI has exited. Its caller must
// still be waiting, so retry/cleanup cannot race the outstanding receipt write.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const [directory, workspace, moduleFile] = process.argv.slice(2);
let settled = false,
  receiptFile;
let releaseReceipt, reachedReceipt, observedExit;
const release = new Promise((resolve) => {
  releaseReceipt = resolve;
});
const receipt = new Promise((resolve) => {
  reachedReceipt = resolve;
});
const exited = new Promise((resolve) => {
  observedExit = resolve;
});
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (
    String(to).includes("initializations") &&
    JSON.parse(await fs.readFile(from, "utf8")).projectId === "created"
  ) {
    receiptFile = to;
    reachedReceipt();
    await release;
  }
  return rename(from, to);
};
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (Array.isArray(args[1]) && args[1].includes("init"))
    child.once("close", async () => {
      await receipt;
      await new Promise((resolve) => setImmediate(resolve));
      const stillWaiting = !settled;
      releaseReceipt();
      observedExit(stillWaiting);
    });
  return child;
};
syncBuiltinESMExports();
const maker = await import(pathToFileURL(moduleFile));
const operation = maker
  .create({ directory, workspace, progress() {} }, { name: "Receipt test" })
  .then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
assert.equal(
  await exited,
  true,
  "Initialization returned before its identity write completed",
);
const result = await operation;
assert.ok(result.error, "The checkout failure must still reach the caller");
assert.equal(
  JSON.parse(await fs.readFile(receiptFile, "utf8")).projectId,
  "created",
);
console.log("Failed checkout waited for its identity receipt");
