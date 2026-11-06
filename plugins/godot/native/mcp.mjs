// Starts the Godot MCP server (godot-mcp) with the Godot this plugin's tools
// use, and passes the MCP session through on stdio. The setting arrives in
// OHMYGAME_GODOT_SETTING; when no Godot is found, godot-mcp looks for one
// itself.
//
// Stopping this script stops what godot-mcp started too, such as a game it
// runs: on POSIX it runs in its own process group, which is signalled as a
// whole; on Windows, Node keeps its children in a job that ends with it.

import { spawn } from "node:child_process";
import { findGodot } from "./godot.mjs";

const GODOT_MCP = "@coding-solo/godot-mcp@0.1.1";
const windows = process.platform === "win32";

const env = { ...process.env };
const godot = await findGodot(env.OHMYGAME_GODOT_SETTING);
delete env.OHMYGAME_GODOT_SETTING;
if (godot) env.GODOT_PATH = godot;

// npx is npx.cmd on Windows, which only a shell runs; the arguments are fixed.
const child = spawn("npx", ["-y", GODOT_MCP], { stdio: "inherit", env, shell: windows, detached: !windows, windowsHide: true });

/** Signals godot-mcp and everything it started. */
function stop(signal) {
  try {
    if (windows) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));
child.on("error", (error) => {
  console.error(`Could not start ${GODOT_MCP}: ${error.message}. It needs Node.js with npx.`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  // What godot-mcp left running goes with it.
  stop("SIGTERM");
  process.exit(code ?? (signal ? 1 : 0));
});
