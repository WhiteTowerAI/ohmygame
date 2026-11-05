// Finds the Godot executable. The native tools and the Godot MCP server both
// use it, so they always run the same Godot.

import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Godot's own Windows file names: the downloads, such as
 * `Godot_v4.3-stable_win64.exe` or `Godot_v4.4-stable_windows_arm64.exe`, and the Steam build, such as
 * `godot.windows.editor.x86_64.exe`. The `_console` companion only wraps the
 * editor, so it is not chosen.
 */
const WINDOWS_RELEASE = /^godot_v\d[^\\/]*_(?:win32|win64|windows_arm64)\.exe$/i;
const WINDOWS_STEAM = /^godot\.windows\.(?:editor|opt\.tools)\.(?:x86_64|64|arm64)\.exe$/i;

/** A variable read case-insensitively, as Windows names them. */
function variable(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** Godot executables in a folder, by their exact names, then Godot's own Windows names, newest first. */
async function inFolder(folder, platform) {
  const names = platform === "win32" ? ["godot.exe", "godot4.exe"] : ["godot", "godot4"];
  const exact = names.map((name) => path.join(folder, name));
  if (platform !== "win32") return exact;
  const entries = await readdir(folder).catch(() => []);
  const released = entries
    .filter((name) => WINDOWS_RELEASE.test(name) || WINDOWS_STEAM.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true, sensitivity: "base" }));
  return [...exact, ...released.map((name) => path.join(folder, name))];
}

/** Where Steam is installed: the registry, or its default folder. */
function steamRoot(env) {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
      { timeout: 3_000, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        const found = !error && /SteamPath\s+REG_\w+\s+(.+)/i.exec(stdout ?? "")?.[1]?.trim();
        const programs = variable(env, "PROGRAMFILES(X86)") ?? variable(env, "PROGRAMFILES");
        resolve(found ? path.win32.normalize(found) : programs ? path.join(programs, "Steam") : undefined);
      },
    );
  });
}

/** Godot's folder in every Steam library, on whichever drive the library is. */
async function steamFolders(env, root) {
  const steam = root ?? (await steamRoot(env));
  if (!steam) return [];
  const libraries = [steam];
  const vdf = await readFile(path.join(steam, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => "");
  for (const match of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) libraries.push(match[1].replace(/\\\\/g, "\\"));
  return [...new Set(libraries.map((library) => path.join(library, "steamapps", "common", "Godot Engine")))];
}

/** Folders package managers put Godot in on Windows, outside a PATH the app may not have been given. */
function windowsFolders(env, home) {
  const local = variable(env, "LOCALAPPDATA");
  return [
    ...(local ? [path.join(local, "Programs", "Godot"), path.join(local, "Microsoft", "WinGet", "Links")] : []),
    path.join(variable(env, "SCOOP") ?? path.join(home, "scoop"), "shims"),
  ];
}

/** Where Godot may be, after the setting and `GODOT_PATH`: the PATH, then the usual install folders. */
async function candidates(configured, { platform, env, home, steam }) {
  const fromPath = (variable(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  const known =
    platform === "darwin"
      ? ["/Applications/Godot.app/Contents/MacOS/Godot", path.join(home, "Applications/Godot.app/Contents/MacOS/Godot")]
      : platform === "win32"
        ? []
        : ["/usr/bin/godot", "/usr/local/bin/godot", "/snap/bin/godot", "/var/lib/flatpak/exports/bin/org.godotengine.Godot"];
  const folders =
    platform === "win32" ? [...fromPath, ...windowsFolders(env, home), ...(await steamFolders(env, steam))] : fromPath;
  const found = await Promise.all([...new Set(folders)].map((folder) => inFolder(folder, platform)));
  const godotPath = variable(env, "GODOT_PATH");
  return [...(configured ? [configured] : []), ...(godotPath ? [godotPath] : []), ...found.flat(), ...known];
}

/** The Godot setting is a path to the executable, or to Godot.app on macOS. */
function executableAt(setting, platform) {
  if (typeof setting !== "string" || !setting.trim()) return undefined;
  const value = setting.trim();
  return platform === "darwin" && value.endsWith(".app") ? path.join(value, "Contents/MacOS/Godot") : value;
}

/**
 * The first Godot that can run, from the setting, then the usual places; undefined when none.
 * `options` replaces the platform, environment, home folder and Steam folder, for tests.
 */
export async function findGodot(setting, options = {}) {
  const resolved = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    home: options.home ?? os.homedir(),
    steam: options.steam,
  };
  for (const candidate of await candidates(executableAt(setting, resolved.platform), resolved)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}
