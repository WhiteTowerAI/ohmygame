import { execFile, type ChildProcess } from "node:child_process";
import { unlinkSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { signalProcessTree } from "../process-lifecycle.js";

interface ProcessRecord {
  version: 1;
  pid: number;
  identity: string;
  owner: number;
  ownerIdentity: string;
}

const pendingIdentities = new Map<number, Promise<string | undefined>>();
let identityQueue: Promise<unknown> = Promise.resolve();

/**
 * Birth time and executable, never command arguments (which may contain credentials).
 * PowerShell can take seconds to start on a busy Windows machine, so lookups
 * run off the event loop with room to finish, one at a time: concurrent cold
 * starts slow each other down. A PID already being looked up shares the lookup.
 */
export function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined);
  let identity = pendingIdentities.get(pid);
  if (!identity) {
    // A failed spawn must not reject the queue and disable all later lookups.
    identity = identityQueue
      .then(() => lookUpIdentity(pid))
      .catch(() => undefined);
    identityQueue = identity;
    pendingIdentities.set(pid, identity);
    void identity.then(() => pendingIdentities.delete(pid));
  }
  return identity;
}

function lookUpIdentity(pid: number): Promise<string | undefined> {
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks; $p.Path }`,
          ],
        ]
      : ["/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="]];
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve((!error && stdout.trim()) || undefined),
    ).stdin?.end();
  });
}

/** One lookup per owner within a recovery pass; leftovers usually share one. */
function ownerLookups(): (pid: number) => Promise<string | undefined> {
  const known = new Map<number, Promise<string | undefined>>();
  return (pid) => {
    let identity = known.get(pid);
    if (!identity) known.set(pid, (identity = processIdentity(pid)));
    return identity;
  };
}

/** False only when inspection proves the original process no longer owns this PID. */
async function originalProcessLives(
  pid: number,
  identity: string,
  lookup: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
  const current = await lookup(pid);
  if (current) return current === identity;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

let ownIdentity: Promise<string | undefined> | undefined;

/**
 * The daemon's own identity cannot change while it runs, so one successful
 * lookup serves every lease and journal. Nothing waits on them, so a failed
 * lookup is tried again by the next one.
 */
function daemonIdentity(): Promise<string | undefined> {
  return (ownIdentity ??= processIdentity(process.pid).then((identity) => {
    if (!identity) ownIdentity = undefined;
    return identity;
  }));
}

export interface AgentDirectoryLease {
  /** Settles once the lease is written or given up; it never rejects. */
  readonly written: Promise<void>;
  /** Drops a lease not yet written and waits for one being written. */
  release(): Promise<void>;
}

/**
 * A private folder belongs to a daemon, not to whichever daemon next starts.
 * The lease is written beside the folder's work, which never waits for the
 * identity lookup; until it lands, recovery leaves the folder alone.
 */
export function leaseAgentDirectory(directory: string): AgentDirectoryLease {
  let released = false;
  let writing: Promise<void> | undefined;
  const written = daemonIdentity().then((identity) => {
    if (!identity || released) return;
    writing = writeFile(
      path.join(directory, ".owner.json"),
      JSON.stringify({ version: 1, pid: process.pid, identity }),
      { mode: 0o600 },
    ).catch(() => {});
    return writing;
  });
  return {
    written,
    async release() {
      released = true;
      await writing;
    },
  };
}

export async function recoverAgentDirectories(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const lookup = ownerLookups();
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
    if (!(await originalProcessLives(lease.pid, lease.identity, lookup)))
      await rm(directory, { recursive: true, force: true });
  }
}

/** A durable ownership record for standalone daemon crash recovery. */
export function trackAgentProcess(
  directory: string,
  child: ChildProcess,
): void {
  let file: string | undefined;
  let closed = false;
  child.once("spawn", async () => {
    const pid = child.pid;
    if (!pid) return;
    const [identity, ownerIdentity] = await Promise.all([
      processIdentity(pid),
      daemonIdentity(),
    ]);
    if (!identity || !ownerIdentity || closed) return; // Never reclaim a PID without evidence.
    const record = path.join(directory, `${process.pid}-${pid}.json`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        record,
        JSON.stringify({
          version: 1,
          pid,
          identity,
          owner: process.pid,
          ownerIdentity,
        } satisfies ProcessRecord),
        { mode: 0o600 },
      );
    } catch {
      return; /* Desktop IPC and normal shutdown still own the process. */
    }
    file = record;
    // The process may have exited while its record was being written.
    if (closed) await rm(record, { force: true }).catch(() => {});
  });
  child.once("close", () => {
    closed = true;
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
  const lookup = ownerLookups();
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
    if (await originalProcessLives(record.owner, record.ownerIdentity, lookup))
      continue;
    if ((await processIdentity(record.pid)) === record.identity) {
      await signalProcessTree(record.pid, true);
    }
    await rm(file, { force: true });
  }
}
