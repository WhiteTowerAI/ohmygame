import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = path.join(root, "packages", "sdk");
const source = path.join(root, "examples", "sdk-starter");
const command = process.platform === "win32" ? "npm.cmd" : "npm";
const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-sdk-pack-"));
const example = path.join(directory, "sdk-starter");

function run(args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`,
    );
  }
}

try {
  run(["run", "build"], sdk);
  const packed = spawnSync(command, ["pack", sdk, "--json"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr);
    throw new Error(
      `${command} pack failed with exit code ${packed.status ?? 1}.`,
    );
  }

  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(directory, filename);
  await cp(source, example, {
    recursive: true,
    filter: (entry) => !["node_modules", "dist"].includes(path.basename(entry)),
  });
  run(["ci"], example);
  run(["install", "--save-exact", tarball], example);
  run(["run", "build"], example);
} finally {
  await rm(directory, { recursive: true, force: true });
}
