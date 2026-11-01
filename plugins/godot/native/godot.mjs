// Finds the Godot executable. The native tools and the Godot MCP server both
// use it, so they always run the same Godot.

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where Godot is usually installed, after the setting, `GODOT_PATH` and the PATH. */
function candidates(configured) {
  const names = process.platform === "win32" ? ["godot.exe", "godot4.exe"] : ["godot", "godot4"];
  const fromPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((folder) => names.map((name) => path.join(folder, name)));
  const known =
    process.platform === "darwin"
      ? ["/Applications/Godot.app/Contents/MacOS/Godot", path.join(os.homedir(), "Applications/Godot.app/Contents/MacOS/Godot")]
      : process.platform === "win32"
        ? [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Godot", "godot.exe")]
        : ["/usr/bin/godot", "/usr/local/bin/godot", "/snap/bin/godot", "/var/lib/flatpak/exports/bin/org.godotengine.Godot"];
  return [
    ...(configured ? [configured] : []),
    ...(process.env.GODOT_PATH ? [process.env.GODOT_PATH] : []),
    ...fromPath,
    ...known,
  ];
}

/** The Godot setting is a path to the executable, or to Godot.app on macOS. */
function executableAt(setting) {
  if (typeof setting !== "string" || !setting.trim()) return undefined;
  const value = setting.trim();
  return process.platform === "darwin" && value.endsWith(".app") ? path.join(value, "Contents/MacOS/Godot") : value;
}

/** The first Godot that can run, from the setting, then the usual places; undefined when none. */
export async function findGodot(setting) {
  for (const candidate of candidates(executableAt(setting))) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}
