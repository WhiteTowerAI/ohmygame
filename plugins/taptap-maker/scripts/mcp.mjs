import { spawn } from "node:child_process";
import { installed, makerEnvironment, makerPath } from "./runtime.mjs";

const directory = process.env.OHMYGAME_PLUGIN_DATA_DIR;
if (!directory || !(await installed(directory))) {
  process.stderr.write(
    "Prepare TapTap Maker in OhMyGame Plugins before connecting its MCP.\n",
  );
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [makerPath(directory)], {
    env: makerEnvironment(directory),
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
