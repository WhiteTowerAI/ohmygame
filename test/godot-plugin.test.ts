import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The plugin's native code is plain JavaScript.
import { findGodot } from "../plugins/godot/native/godot.mjs";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "omg-godot-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function executable(...parts: string[]): Promise<string> {
  const file = path.join(root, ...parts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
  await chmod(file, 0o755);
  return file;
}

// Windows lookups run on every platform with a stand-in environment; `path` joins with this platform's separator.
const windows = (
  env: Record<string, string>,
  steam = path.join(root, "no-steam"),
) => ({
  platform: "win32",
  env,
  home: path.join(root, "home"),
  steam,
});

describe("finding Godot", () => {
  it("prefers the setting, then GODOT_PATH, to anything it finds", async () => {
    const chosen = await executable("chosen", "Godot.exe");
    const variable = await executable("variable", "Godot.exe");
    await executable("bin", "godot.exe");
    const options = windows({
      Path: path.join(root, "bin"),
      GODOT_PATH: variable,
    });
    expect(await findGodot(chosen, options)).toBe(chosen);
    expect(await findGodot("", options)).toBe(variable);
    expect(await findGodot(path.join(root, "missing.exe"), options)).toBe(
      variable,
    );
  });

  it("finds a downloaded Godot on the PATH by its release name, newest first, never the console wrapper", async () => {
    const folder = path.join(root, "D", "Tools", "Godot");
    await executable(
      "D",
      "Tools",
      "Godot",
      "Godot_v4.3-stable_win64_console.exe",
    );
    await executable("D", "Tools", "Godot", "Godot_v4.3-stable_win64.exe");
    const newest = await executable(
      "D",
      "Tools",
      "Godot",
      "Godot_v4.10-stable_win64.exe",
    );
    expect(await findGodot(undefined, windows({ PATH: folder }))).toBe(newest);

    const arm = path.join(root, "arm");
    const forArm = await executable(
      "arm",
      "Godot_v4.4-stable_windows_arm64.exe",
    );
    expect(await findGodot(undefined, windows({ PATH: arm }))).toBe(forArm);
  });

  it("finds Godot in a Steam library on another drive and in package manager folders", async () => {
    const steam = path.join(root, "Steam");
    const library = path.join(root, "E", "SteamLibrary");
    await mkdir(path.join(steam, "steamapps"), { recursive: true });
    await writeFile(
      path.join(steam, "steamapps", "libraryfolders.vdf"),
      `"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"${library.replace(/\\/g, "\\\\")}"\n\t}\n}\n`,
    );
    const fromSteam = await executable(
      "E",
      "SteamLibrary",
      "steamapps",
      "common",
      "Godot Engine",
      "godot.windows.editor.x86_64.exe",
    );
    expect(await findGodot(undefined, windows({}, steam))).toBe(fromSteam);

    const scoop = await executable("home", "scoop", "shims", "godot.exe");
    expect(await findGodot(undefined, windows({}, steam))).toBe(scoop);
    const winget = await executable(
      "Local",
      "Microsoft",
      "WinGet",
      "Links",
      "godot.exe",
    );
    expect(
      await findGodot(
        undefined,
        windows({ LOCALAPPDATA: path.join(root, "Local") }, steam),
      ),
    ).toBe(winget);
  });

  it("looks only for godot and godot4 by name elsewhere", async () => {
    await executable("bin", "Godot_v4.3-stable_linux.x86_64");
    const options = {
      platform: "linux",
      env: { PATH: path.join(root, "bin") },
      home: root,
    };
    expect(await findGodot(undefined, options)).toBeUndefined();
    const godot = await executable("bin", "godot4");
    expect(await findGodot(undefined, options)).toBe(godot);
  });
});
