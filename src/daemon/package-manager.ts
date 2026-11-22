import { constants, existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_PACKAGE_MANAGERS,
  type ProjectPackageManager,
} from "../shared/contracts.js";
import { npmShimTarget } from "./agent-runtimes/npm-shim.js";

const PACKAGE_MANAGER_FILES: ReadonlyArray<
  readonly [string, ProjectPackageManager]
> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["pnpm-workspace.yaml", "pnpm"],
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
  return (await packageManagerFromFiles(workspacePath)) ?? {
    manager: "npm",
    source: "Default: no package manager declaration or lockfile",
  };
}

export async function packageManagerFromFiles(directory: string) {
  for (const [file, manager] of PACKAGE_MANAGER_FILES) {
    if (await exists(path.join(directory, file))) return { manager, source: file };
  }
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

const WIN_CMD_UNSAFE = /[&|<>^%!"\r\n]/;

/** Unwraps Windows `.cmd`/`.bat` shims directly to Node when possible, escaping fallback shell arguments safely. */
export function packageManagerSpawn(
  executable: string,
  args: readonly string[],
  environment: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args], shell: false };
  }
  const shim = npmShimTarget(executable, environment);
  if (shim) {
    return { command: shim.file, args: [...shim.args, ...args], shell: false };
  }
  if (/(?:^|[/\\])npm\.cmd$/i.test(executable)) {
    const directory = path.dirname(executable);
    const node = path.join(directory, "node.exe");
    const npmCli = path.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(node) && existsSync(npmCli)) {
      return { command: node, args: [npmCli, ...args], shell: false };
    }
  }
  const safeArgs = args.map((arg) => {
    if (WIN_CMD_UNSAFE.test(arg)) {
      throw new Error("Unsafe character in package manager argument for Windows command script");
    }
    return /[ \t]/.test(arg) ? `"${arg}"` : arg;
  });
  return { command: `"${executable}"`, args: safeArgs, shell: true };
}

export function packageManagerInstallArguments(
  manager: ProjectPackageManager,
): string[] {
  return manager === "npm"
    ? ["install", "--no-audit", "--no-fund"]
    : ["install"];
}

export function packageManagerRunArguments(
  manager: ProjectPackageManager,
  script: string,
  arguments_: string[] = [],
): string[] {
  if (manager === "npm" && arguments_.length) return ["run", script, "--", ...arguments_];
  return ["run", script, ...arguments_];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
