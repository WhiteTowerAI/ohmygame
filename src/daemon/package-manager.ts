import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_PACKAGE_MANAGERS,
  type ProjectPackageManager,
} from "../shared/contracts.js";

const LOCKFILE_MANAGERS: ReadonlyArray<
  readonly [string, ProjectPackageManager]
> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

export function isProjectPackageManager(
  value: unknown,
): value is ProjectPackageManager {
  return (
    typeof value === "string" &&
    (PROJECT_PACKAGE_MANAGERS as readonly string[]).includes(value)
  );
}

export async function resolvePackageManager(
  workspacePath: string,
  configured?: ProjectPackageManager,
): Promise<{ manager: ProjectPackageManager; source: string }> {
  if (configured) return { manager: configured, source: "Project setting" };
  try {
    const declared = (
      JSON.parse(
        await readFile(path.join(workspacePath, "package.json"), "utf8"),
      ) as { packageManager?: unknown }
    ).packageManager;
    if (typeof declared === "string") {
      const manager = declared.split("@")[0];
      if (!isProjectPackageManager(manager))
        throw new Error(`Unsupported package manager: ${declared}`);
      return { manager, source: `package.json: ${declared}` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (await exists(path.join(workspacePath, lockfile)))
      return { manager, source: lockfile };
  }
  return {
    manager: "npm",
    source: "Default: no package manager declaration or lockfile",
  };
}

/** Resolve against the environment actually used by the child, including bundled Node/npm. */
export async function resolvePackageManagerExecutable(
  manager: ProjectPackageManager,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pathKey = Object.keys(environment).find(
    (key) => key.toLowerCase() === "path",
  );
  const command = packageManagerCommand(manager);
  const extensionsKey = Object.keys(environment).find(
    (key) => key.toLowerCase() === "pathext",
  );
  const candidates =
    process.platform === "win32"
      ? [
          ...new Set([
            command,
            ...windowsExecutableNames(
              manager,
              environment[extensionsKey ?? "PATHEXT"],
            ),
          ]),
        ]
      : [command];
  const found = await findExecutable(
    candidates,
    (pathKey ? (environment[pathKey] ?? "") : "").split(path.delimiter),
  );
  if (found) return found;
  throw new Error(
    `This project uses ${manager}, but ${manager} was not found in the application environment. Install or configure ${manager}, or choose a different package manager in Project settings.`,
  );
}

/** Adds each valid PATHEXT extension; a bare name is left to the caller. */
export function windowsExecutableNames(
  command: string,
  extensions = ".COM;.EXE;.BAT;.CMD",
): string[] {
  return extensions
    .split(";")
    .filter((extension) => /^\.[a-z0-9]+$/i.test(extension))
    .map((extension) => `${command}${extension.toLowerCase()}`);
}

/** Returns the first candidate that is an executable file in one of the directories. */
export async function findExecutable(
  candidates: string[],
  directories: string[],
): Promise<string | undefined> {
  for (const directory of directories) {
    if (!directory) continue;
    for (const filename of candidates) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), filename);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

export function packageManagerCommand(manager: ProjectPackageManager): string {
  if (manager === "npm" && process.platform === "win32") return "npm.cmd";
  if (manager === "pnpm" && process.platform === "win32") return "pnpm.cmd";
  if (manager === "yarn" && process.platform === "win32") return "yarn.cmd";
  if (manager === "bun" && process.platform === "win32") return "bun.exe";
  return manager;
}

/** cmd.exe requires quoting when the bundled runtime lives under Program Files. */
export function packageManagerSpawnCommand(executable: string): string {
  return process.platform === "win32" ? `"${executable}"` : executable;
}

export function packageManagerInstallArguments(
  manager: ProjectPackageManager,
): string[] {
  return manager === "npm"
    ? ["install", "--no-audit", "--no-fund"]
    : ["install"];
}

export function packageManagerRunArguments(
  script: string,
  arguments_: string[] = [],
): string[] {
  return ["run", script, ...(arguments_.length ? ["--", ...arguments_] : [])];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
