import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-game-"));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require("electron"), [path.join(import.meta.dirname, "web-game-runtime-check.cjs"), directory], { stdio: "inherit", env: environment });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
} finally {
  await rm(directory, { recursive: true, force: true });
}
