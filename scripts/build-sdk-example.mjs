import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "examples", "sdk-starter");
const command = process.platform === "win32" ? "npm.cmd" : "npm";
const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-sdk-starter-"));

try {
  await cp(source, directory, {
    recursive: true,
    filter: (entry) => !["node_modules", "dist"].includes(path.basename(entry)),
  });
  for (const args of [["ci"], ["run", "build"]]) {
    const result = spawnSync(command, args, {
      cwd: directory,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (process.exitCode) break;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
