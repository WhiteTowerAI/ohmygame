import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { trackAgentProcess } from "./process-recovery.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "../process-lifecycle.js";

export interface AgentProcessOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  processDirectory?: string;
  /** Called for each line the CLI writes to stdout. */
  onLine?: (line: string) => void;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ) => void;
}

const STDERR_TAIL = 8_000;
let spawnProcess: typeof spawn = spawn;
/** Every CLI process the daemon has running, so shutting down can wait for all of them to stop. */
const live = new Set<AgentProcess>();

export async function stopAgentProcesses(): Promise<void> {
  await Promise.allSettled([...live].map((child) => child.stop()));
}

/** Tests replace the spawner with a fake CLI. */
export function setAgentProcessSpawner(
  spawner: typeof spawn | undefined,
): void {
  spawnProcess = spawner ?? spawn;
}

/**
 * A CLI process the daemon owns. It runs in its own process group so a stop
 * ends everything it started, and the desktop app reclaims the group if the
 * daemon dies first. Its stdin stays open for the protocols that keep
 * talking; the absolute binary path is run, never one found in the workspace.
 */
export class AgentProcess {
  readonly child: ChildProcess;
  #stderr = "";
  #exited: Promise<void>;
  #stopping?: Promise<void>;

  constructor(options: AgentProcessOptions) {
    this.child = spawnProcess(options.binaryPath, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    registerProjectProcess(this.child);
    if (options.processDirectory)
      trackAgentProcess(options.processDirectory, this.child);
    live.add(this);
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
    });
    if (options.onLine && this.child.stdout) {
      readline
        .createInterface({ input: this.child.stdout, crlfDelay: Infinity })
        .on("line", options.onLine);
    }
    // A write to a CLI that has gone away is reported through its exit, not as an unhandled error.
    this.child.stdin?.on("error", () => {});
    this.#exited = new Promise((resolve) => {
      let reported = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (reported) return;
        reported = true;
        live.delete(this);
        options.onExit?.(code, signal, this.#stderr);
        resolve();
      };
      this.child.once("error", (cause) => {
        this.#stderr += `\n${cause.message}`;
        finish(null, null);
      });
      this.child.once("close", finish);
    });
  }

  get running(): boolean {
    return (
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.killed
    );
  }

  get stderr(): string {
    return this.#stderr;
  }

  write(message: unknown): void {
    if (!this.child.stdin || this.child.stdin.destroyed)
      throw new Error("The agent process is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  exited(): Promise<void> {
    return this.#exited;
  }

  stop(): Promise<void> {
    return (this.#stopping ??= (async () => {
      this.child.stdin?.end();
      await terminateProjectProcess(this.child).catch(() => {});
      await Promise.race([
        this.#exited,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    })());
  }
}

/** A failure message from a CLI's last words, without its whole log. */
export function processFailure(
  name: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const tail = stderr.trim().split("\n").filter(Boolean).slice(-6).join("\n");
  const status = signal
    ? `was stopped (${signal})`
    : `exited with code ${code ?? "unknown"}`;
  return tail ? `${name} ${status}: ${tail}` : `${name} ${status}`;
}
