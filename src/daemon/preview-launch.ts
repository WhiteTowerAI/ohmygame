import { readFile, access } from "node:fs/promises";
import path from "node:path";

/** Unknown package scripts receive PORT/HOST rather than Vite-specific flags. */
export function previewScriptArguments(
  command: string,
  port: number,
  configured?: string[],
): string[] {
  if (configured)
    return configured.map((value) =>
      value
        .replaceAll("{port}", String(port))
        .replaceAll("{host}", "127.0.0.1"),
    );
  if (/(?:^|[\s/])vite(?:\s|$)/.test(command))
    return ["--host", "127.0.0.1", "--port", String(port), "--strictPort"];
  if (/(?:^|[\s/])next\s+(?:dev|start)(?:\s|$)/.test(command))
    return ["--hostname", "127.0.0.1", "--port", String(port)];
  if (
    /(?:^|[\s/])(?:astro|nuxt|nuxi)\s+(?:dev|start|preview)(?:\s|$)/.test(
      command,
    )
  )
    return ["--host", "127.0.0.1", "--port", String(port)];
  if (/webpack(?:-dev-server|\s+serve)/.test(command))
    return ["--host", "127.0.0.1", "--port", String(port)];
  return [];
}

/** Install monorepo dependencies at their owning root, while running in the selected package. */
export async function previewDependencyDirectory(
  workspaceRoot: string,
  startupDirectory: string,
): Promise<string> {
  let directory = startupDirectory;
  while (true) {
    if (await hasLockfile(directory)) return directory;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      );
      if (manifest.workspaces || manifest.packageManager) return directory;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (directory === workspaceRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    if (path.relative(workspaceRoot, parent).startsWith("..")) break;
    directory = parent;
  }
  return startupDirectory;
}

async function hasLockfile(directory: string): Promise<boolean> {
  for (const file of [
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]) {
    try {
      await access(path.join(directory, file));
      return true;
    } catch {}
  }
  return false;
}
