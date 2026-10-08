import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectPackageManager } from "../shared/contracts.js";
import { packageManagerCommand, packageManagerInstallArguments } from "./package-manager.js";

const PENDING_INSTALL = ".ohmygame-install-pending";
const installs = new Map<string, Promise<void>>();

/** Keeps failed or interrupted installs retryable, including after app restarts. */
export function ensureProjectDependencies(
  workspacePath: string,
  manager: ProjectPackageManager,
  run: (command: string, args: string[]) => Promise<void>,
): Promise<void> {
  const key = path.resolve(workspacePath);
  const operation = (installs.get(key) ?? Promise.resolve()).catch(() => {}).then(() => installProjectDependencies(key, manager, run));
  installs.set(key, operation);
  void operation.finally(() => { if (installs.get(key) === operation) installs.delete(key); }).catch(() => {});
  return operation;
}

async function installProjectDependencies(
  workspacePath: string,
  manager: ProjectPackageManager,
  run: (command: string, args: string[]) => Promise<void>,
): Promise<void> {
  const pending = path.join(workspacePath, PENDING_INSTALL);
  const modules = path.join(workspacePath, "node_modules");
  let needsInstall = await exists(pending) || !await exists(modules);
  if (!needsInstall) {
    const packageJson = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>;
    };
    const dependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    needsInstall = (await Promise.all(dependencies.map((name) => exists(path.join(modules, name, "package.json"))))).some((installed) => !installed);
  }
  if (!needsInstall) return;
  await writeFile(pending, "Dependency installation has not completed.\n");
  // An esbuild postinstall can persist its binary override in the installed JS.
  // Reinstall incomplete dependencies instead of reusing those patched files.
  await rm(modules, { recursive: true, force: true });
  await run(packageManagerCommand(manager), packageManagerInstallArguments(manager));
  await rm(pending, { force: true });
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}
