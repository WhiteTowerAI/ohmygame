import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import {
  access,
  readFile,
  rm,
  writeFile,
  mkdir,
  glob,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectPackageManager } from "../shared/contracts.js";
import {
  packageManagerCommand,
  packageManagerInstallArguments,
} from "./package-manager.js";

const PENDING_INSTALL = ".ohmygame-install-pending";
const installs = new Map<string, Promise<void>>();

/** Keeps failed or interrupted installs retryable, including after app restarts. */
export function ensureProjectDependencies(
  workspacePath: string,
  manager: ProjectPackageManager,
  run: (command: string, args: string[]) => Promise<void>,
  force = false,
  assertCurrent?: () => void,
): Promise<void> {
  const key = path.resolve(workspacePath);
  const operation = (installs.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() =>
      installProjectDependencies(key, manager, run, force, assertCurrent),
    );
  installs.set(key, operation);
  void operation
    .finally(() => {
      if (installs.get(key) === operation) installs.delete(key);
    })
    .catch(() => {});
  return operation;
}

async function installProjectDependencies(
  workspacePath: string,
  manager: ProjectPackageManager,
  run: (command: string, args: string[]) => Promise<void>,
  force: boolean,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const pending = path.join(workspacePath, PENDING_INSTALL);
  const modules = path.join(workspacePath, "node_modules");
  const stamp = path.join(modules, ".ohmygame-dependencies.json");
  const { fingerprint, manifests } = await dependencySnapshot(
    workspacePath,
    manager,
    assertCurrent,
  );
  let previous: string | undefined;
  try {
    previous = JSON.parse(await readFile(stamp, "utf8")).fingerprint;
  } catch {}
  let needsInstall =
    force ||
    (await exists(pending)) ||
    !(await exists(modules)) ||
    (previous !== undefined && previous !== fingerprint);
  if (!needsInstall) {
    for (const { directory, manifest } of manifests) {
      assertCurrent?.();
      const dependencies = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      });
      if (
        (
          await Promise.all(
            dependencies.map((name) =>
              installedDependency(
                workspacePath,
                directory,
                name,
                assertCurrent,
              ),
            ),
          )
        ).some((installed) => !installed)
      ) {
        needsInstall = true;
        break;
      }
    }
  }
  if (!needsInstall) {
    assertCurrent?.();
    if (!previous) await writeFile(stamp, JSON.stringify({ fingerprint }));
    return;
  }
  assertCurrent?.();
  await writeFile(pending, "Dependency installation has not completed.\n");
  // An esbuild postinstall can persist its binary override in the installed JS.
  // Reinstall incomplete dependencies instead of reusing those patched files.
  assertCurrent?.();
  await rm(modules, { recursive: true, force: true });
  assertCurrent?.();
  await run(
    packageManagerCommand(manager),
    packageManagerInstallArguments(manager),
  );
  assertCurrent?.();
  await mkdir(modules, { recursive: true });
  const snapshot = await dependencySnapshot(
    workspacePath,
    manager,
    assertCurrent,
  );
  assertCurrent?.();
  await writeFile(stamp, JSON.stringify({ fingerprint: snapshot.fingerprint }));
  assertCurrent?.();
  await rm(pending, { force: true });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

type DependencyManifest = {
  name?: string;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: string[] | { packages?: string[] };
  [key: string]: unknown;
};
async function dependencySnapshot(
  directory: string,
  manager: ProjectPackageManager,
  assertCurrent?: () => void,
): Promise<{
  fingerprint: string;
  manifests: { directory: string; manifest: DependencyManifest }[];
}> {
  assertCurrent?.();
  const hash = createHash("sha256").update(manager);
  const manifest: DependencyManifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  const manifests = [{ directory, manifest }];
  let patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  try {
    patterns =
      parseYaml(
        await readFile(path.join(directory, "pnpm-workspace.yaml"), "utf8"),
      )?.packages ?? patterns;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (patterns.length) {
    const included = patterns
      .filter(
        (pattern) =>
          !pattern.startsWith("!") &&
          !path.isAbsolute(pattern) &&
          !pattern.split(/[\\/]/).includes(".."),
      )
      .map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`);
    const excluded = patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1).replace(/\/$/, ""));
    const files = new Set<string>();
    // Let glob follow only declared workspace paths, rather than walking game assets.
    for await (const file of glob(included, {
      cwd: directory,
      exclude: (match) => {
        assertCurrent?.();
        const relative = (
          path.isAbsolute(match) ? path.relative(directory, match) : match
        ).replaceAll("\\", "/");
        return (
          relative
            .split("/")
            .some(
              (part) =>
                part.startsWith(".") ||
                ["node_modules", "dist", "build"].includes(part),
            ) ||
          excluded.some(
            (pattern) =>
              path.matchesGlob(relative, pattern) ||
              path.matchesGlob(relative, `${pattern}/**`),
          )
        );
      },
    })) {
      assertCurrent?.();
      files.add(file);
    }
    const root = await realpath(directory);
    for (const file of [...files].sort()) {
      assertCurrent?.();
      const filename = path.join(directory, file);
      try {
        const relative = path.relative(root, await realpath(filename));
        if (
          relative === "package.json" ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        )
          continue;
        assertCurrent?.();
        manifests.push({
          directory: path.dirname(filename),
          manifest: JSON.parse(await readFile(filename, "utf8")),
        });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
  }
  for (const item of manifests)
    hash
      .update(path.relative(directory, item.directory))
      .update(
        JSON.stringify(
          canonical([
            item.manifest.dependencies,
            item.manifest.devDependencies,
            item.manifest.optionalDependencies,
            item.manifest.peerDependencies,
            item.manifest.overrides,
            item.manifest.resolutions,
            item.manifest.workspaces,
            item.manifest.packageManager,
          ]),
        ),
      );
  for (const file of [
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]) {
    assertCurrent?.();
    try {
      hash.update(file).update(await readFile(path.join(directory, file)));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  assertCurrent?.();
  return { fingerprint: hash.digest("hex"), manifests };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function installedDependency(
  root: string,
  directory: string,
  name: string,
  assertCurrent?: () => void,
): Promise<boolean> {
  let folder = directory;
  while (true) {
    assertCurrent?.();
    if (await exists(path.join(folder, "node_modules", name, "package.json")))
      return true;
    if (folder === root) return false;
    const parent = path.dirname(folder);
    if (parent === folder || path.relative(root, parent).startsWith(".."))
      return false;
    folder = parent;
  }
}
