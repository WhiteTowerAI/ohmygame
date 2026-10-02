import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";

// Shared by the scripts that prepare pinned third-party content under .runtime/.

/** Swaps a freshly prepared directory into place, restoring the old one on failure. */
export async function replaceDirectory(source: string, destination: string): Promise<void> {
  const backup = `${destination}.previous`;
  await rm(backup, { recursive: true, force: true });
  let hasBackup = false;
  try {
    await rename(destination, backup);
    hasBackup = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(source, destination);
  } catch (error) {
    if (hasBackup) await rename(backup, destination);
    throw error;
  }
  if (hasBackup) await rm(backup, { recursive: true, force: true });
}

export function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git exited with ${code}`)));
  });
}
