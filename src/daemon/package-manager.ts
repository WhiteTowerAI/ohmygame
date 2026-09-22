import { access } from "node:fs/promises";
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
): Promise<ProjectPackageManager> {
  if (configured) return configured;
  for (const [lockfile, manager] of LOCKFILE_MANAGERS) {
    if (await exists(path.join(workspacePath, lockfile))) return manager;
  }
  return "npm";
}

export function packageManagerCommand(manager: ProjectPackageManager): string {
  if (manager === "npm" && process.platform === "win32") return "npm.cmd";
  if (manager === "pnpm" && process.platform === "win32") return "pnpm.cmd";
  if (manager === "yarn" && process.platform === "win32") return "yarn.cmd";
  if (manager === "bun" && process.platform === "win32") return "bun.exe";
  return manager;
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
