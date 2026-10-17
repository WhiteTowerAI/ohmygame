import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { signalProcessTree } from "../process-lifecycle.js";

interface ProcessRecord {
  version: 1;
  pid: number;
  identity: string;
  owner: number;
  ownerIdentity: string;
}

/** Birth time and executable, never command arguments (which may contain credentials). */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks; $p.Path }`,
          ],
          { encoding: "utf8", timeout: 3_000, windowsHide: true },
        )
      : spawnSync(
          "/bin/ps",
          ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
          { encoding: "utf8", timeout: 3_000 },
        );
  const identity = result.status === 0 ? result.stdout.trim() : "";
  return identity || undefined;
}

/** False only when inspection proves the original process no longer owns this PID. */
function originalProcessLives(pid: number, identity: string): boolean {
  const current = processIdentity(pid);
  if (current) return current === identity;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

let ownIdentity: string | undefined;

/** The daemon's own identity; it cannot change while the daemon runs, and reading it runs `ps`. */
function daemonIdentity(): string | undefined {
  return (ownIdentity ??= processIdentity(process.pid));
}

/** A private folder belongs to a daemon, not to whichever daemon next starts. */
export async function leaseAgentDirectory(directory: string): Promise<void> {
  const ownIdentity = daemonIdentity();
  if (!ownIdentity) return;
  await writeFile(
    path.join(directory, ".owner.json"),
    JSON.stringify({ version: 1, pid: process.pid, identity: ownIdentity }),
    { mode: 0o600 },
  );
}

export async function recoverAgentDirectories(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const lease = await readFile(path.join(directory, ".owner.json"), "utf8")
      .then(
        (text) =>
          JSON.parse(text) as {
            version?: unknown;
            pid?: unknown;
            identity?: unknown;
          },
      )
      .catch(() => undefined);
    if (
      !lease ||
      lease.version !== 1 ||
      typeof lease.pid !== "number" ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      typeof lease.identity !== "string" ||
      !lease.identity
    )
      continue;
    if (!originalProcessLives(lease.pid, lease.identity))
      await rm(directory, { recursive: true, force: true });
  }
}

/** A durable ownership record for standalone daemon crash recovery. */
export function trackAgentProcess(
  directory: string,
  child: ChildProcess,
): void {
  let file: string | undefined;
  child.once("spawn", () => {
    if (!child.pid) return;
    const identity = processIdentity(child.pid);
    const ownerIdentity = daemonIdentity();
    if (!identity || !ownerIdentity) return; // Never reclaim a PID without evidence.
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      file = path.join(directory, `${process.pid}-${child.pid}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          pid: child.pid,
          identity,
          owner: process.pid,
          ownerIdentity,
        } satisfies ProcessRecord),
        { mode: 0o600 },
      );
    } catch {
      /* Desktop IPC and normal shutdown still own the process. */
    }
  });
  child.once("close", () => {
    if (file) {
      try {
        unlinkSync(file);
      } catch {
        /* Already recovered. */
      }
    }
  });
}

/** Reclaim only a recorded child whose original daemon no longer exists. */
export async function recoverAgentProcesses(directory: string): Promise<void> {
  const files = await readdir(directory).catch(() => []);
  for (const name of files) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    let record: ProcessRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8"));
    } catch {
      await rm(file, { force: true });
      continue;
    }
    if (
      !record ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.owner) ||
      record.owner <= 0 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.identity !== "string" ||
      typeof record.ownerIdentity !== "string"
    ) {
      await rm(file, { force: true });
      continue;
    }
    if (originalProcessLives(record.owner, record.ownerIdentity)) continue;
    if (processIdentity(record.pid) === record.identity) {
      await signalProcessTree(record.pid, true);
    }
    await rm(file, { force: true });
  }
}
