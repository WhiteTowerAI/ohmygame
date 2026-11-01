// The Godot plugin's native entry. It runs in the project's extension host
// and starts Godot as a child process: headless runs and checks for the
// agent, the web export the game panel plays, and the full editor on request.

import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGodot as findGodotAt } from "./godot.mjs";

const OUTPUT_MAX_CHARS = 40_000;
const WEB_BUILD_FOLDER = ".ohmygame/build/web";
const WEB_PRESET = "Web";

/** Runs Godot and collects its output; the call's signal stops it. */
function run(executable, args, { cwd, signal, timeoutMs = 120_000, progress }) {
  return new Promise((resolve, reject) => {
    // A call cancelled while it got ready never starts Godot.
    if (signal?.aborted) {
      reject(new Error("Stopped"));
      return;
    }
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-OUTPUT_MAX_CHARS);
      const line = text.trim().split("\n").pop();
      if (line) progress?.(line);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => child.kill();
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(new Error("Stopped"));
      else resolve({ exitCode, output, errors: errorLines(output) });
    });
  });
}

function errorLines(output) {
  return output
    .split("\n")
    .filter((line) => /^\s*(?:SCRIPT ERROR|ERROR|Parse Error|USER ERROR)\b/.test(line))
    .slice(0, 50)
    .map((line) => line.trim());
}

/** The Godot this call uses, from the plugin's setting, then the usual places. */
const findGodot = (call) => findGodotAt(call?.configuration?.godotPath);

async function requireGodot(call) {
  const executable = await findGodot(call);
  if (!executable)
    throw new Error("Godot isn't installed or wasn't found. Install Godot 4.3 or later, or set its executable in the Godot plugin's settings.");
  return executable;
}

async function godotVersion(executable, signal) {
  const { output } = await run(executable, ["--version"], { signal, timeoutMs: 15_000 });
  return output.trim().split("\n").pop() || null;
}

/**
 * Godot looks for export templates in a folder named after its version and
 * status: `4.6.1.stable.official.14d19694e` uses `4.6.1.stable`, and
 * `4.3.stable.official` uses `4.3.stable`.
 */
function templatesFolder(version) {
  const id = /^\d+\.\d+(?:\.\d+)?\.[a-z0-9]+/.exec(version)?.[0] ?? version;
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/Godot")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? "", "Godot")
        : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "godot");
  return path.join(base, "export_templates", id);
}

async function hasWebTemplates(version) {
  if (!version) return false;
  const files = await readdir(templatesFolder(version)).catch(() => []);
  return files.some((file) => file.startsWith("web_nothreads_release"));
}

/**
 * Refuses a path in the project whose existing parts include a link, so
 * nothing written there can land outside the project.
 */
async function assertNoLinks(project, relative) {
  let current = project;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stats = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new Error(`${path.relative(project, current)} is a link; the web export writes only inside the project`);
  }
}

/**
 * Empties the build folder before each export, so a stale or linked file
 * never stays in what the panel serves.
 */
async function freshBuildFolder(project) {
  await assertNoLinks(project, path.dirname(WEB_BUILD_FOLDER));
  await rm(path.join(project, WEB_BUILD_FOLDER), { recursive: true, force: true });
  await mkdir(path.join(project, WEB_BUILD_FOLDER), { recursive: true });
}

/** Adds the Web preset the build needs when a project lacks it; other presets are kept. */
async function ensureWebPreset(folder) {
  await assertNoLinks(folder, "export_presets.cfg");
  const file = path.join(folder, "export_presets.cfg");
  const text = await readFile(file, "utf8").catch(() => "");
  if (/^name="Web"$/m.test(text)) return;
  const indexes = [...text.matchAll(/^\[preset\.(\d+)\]$/gm)].map((match) => Number(match[1]));
  const next = indexes.length ? Math.max(...indexes) + 1 : 0;
  const preset = [
    `[preset.${next}]`,
    "",
    `name="${WEB_PRESET}"`,
    'platform="Web"',
    "runnable=true",
    'export_filter="all_resources"',
    'exclude_filter=".ohmygame/*"',
    `export_path="${WEB_BUILD_FOLDER}/index.html"`,
    "",
    `[preset.${next}.options]`,
    "",
    "variant/thread_support=false",
    "",
  ].join("\n");
  await writeFile(file, `${text.trimEnd()}${text ? "\n\n" : ""}${preset}`);
}

export function activate(context) {
  const folder = context.project?.folder;
  const needFolder = () => {
    if (!folder) throw new Error("The Godot plugin works in a project");
    return folder;
  };

  // The preview's builds and the agent's exports share one build folder, and
  // each export empties it first, so they take turns.
  let exporting = Promise.resolve();
  const exportWeb = (call) => {
    const turn = exporting.catch(() => {}).then(() => {
      if (call.signal?.aborted) throw call.signal.reason ?? new Error("Cancelled");
      return exportWebNow(call);
    });
    exporting = turn;
    return turn;
  };

  const exportWebNow = async (call) => {
    const project = needFolder();
    const executable = await requireGodot(call);
    const version = await godotVersion(executable, call.signal);
    if (!(await hasWebTemplates(version ?? "")))
      throw new Error(`Godot's web export templates for ${version ?? "this Godot"} aren't installed. In Godot, open Editor > Manage Export Templates and install them.`);
    await ensureWebPreset(project);
    await freshBuildFolder(project);
    call.progress("Importing assets");
    await run(executable, ["--headless", "--path", project, "--import"], { cwd: project, signal: call.signal, timeoutMs: 300_000, progress: call.progress });
    call.progress("Exporting the web build");
    const result = await run(
      executable,
      ["--headless", "--path", project, "--export-release", WEB_PRESET, path.join(project, WEB_BUILD_FOLDER, "index.html")],
      { cwd: project, signal: call.signal, timeoutMs: 600_000, progress: call.progress },
    );
    if (result.exitCode !== 0)
      throw new Error(`The web export failed (exit ${result.exitCode}):\n${result.errors.join("\n") || result.output.slice(-4_000)}`);
    return result;
  };

  context.registerProjectType("godot-game", {
    buildWeb: async (_input, call) => {
      await exportWeb(call);
      return { folder: WEB_BUILD_FOLDER, entry: "index.html" };
    },
  });

  context.registerTool("godot_status", async (_input, call) => {
    const executable = await findGodot(call);
    if (!executable) return { executable: null, version: null, webTemplates: false, problem: "Godot wasn't found" };
    const version = await godotVersion(executable, call.signal).catch(() => null);
    return { executable, version, webTemplates: await hasWebTemplates(version ?? "") };
  });

  context.registerTool("run_headless", async (input, call) => {
    const project = needFolder();
    const executable = await requireGodot(call);
    const frames = Number.isInteger(input?.frames) ? input.frames : 60;
    const args = ["--headless", "--path", project, "--quit-after", String(frames)];
    if (typeof input?.scene === "string") args.push(input.scene);
    return run(executable, args, { cwd: project, signal: call.signal, timeoutMs: 120_000, progress: call.progress });
  });

  context.registerTool("export_web", (_input, call) => exportWeb(call));

  // The full editor, for what the web build can't do. It runs until the
  // person closes it or the project's host stops.
  context.registerCommand("runInGodot", async (_input, call) => {
    const project = needFolder();
    const executable = await requireGodot(call);
    if (call.signal.aborted) throw new Error("Stopped");
    const child = spawn(executable, ["--path", project, "--editor"], { cwd: project, stdio: "ignore", windowsHide: false });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // Cancelled while it started: the editor doesn't stay open.
    if (call.signal.aborted) {
      child.kill();
      throw new Error("Stopped");
    }
    context.onDispose(() => {
      if (child.exitCode === null) child.kill();
    });
    return { started: true };
  });
}
