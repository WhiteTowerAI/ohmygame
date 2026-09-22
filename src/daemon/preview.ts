import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import { packageManagerCommand, packageManagerInstallArguments, packageManagerRunArguments, resolvePackageManager } from "./package-manager.js";
import { resolveStartupDirectory } from "./projects.js";

interface PreviewOptions {
  readinessTimeoutMs?: number;
}

const MAX_ERROR_OUTPUT = 8 * 1024;

export class PreviewManager {
  readonly #running = new Map<string, ChildProcess>();
  readonly #children = new Map<string, Set<ChildProcess>>();
  readonly #operations = new Map<string, symbol>();
  readonly #readinessTimeoutMs: number;

  constructor(
    private readonly events: RuntimeEventBus,
    options: PreviewOptions = {},
  ) {
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
  }

  async start(project: ProjectState): Promise<string> {
    const operation = Symbol(project.id);
    this.#operations.set(project.id, operation);
    project.preview = { status: "starting" };
    this.events.publish(project.id, "preview.starting", {});
    await this.#terminateProject(project.id);

    try {
      this.#assertCurrent(project.id, operation);
      const startupDirectory = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
      const packageManager = await resolvePackageManager(startupDirectory.absolutePath, project.packageManager);
      const command = packageManagerCommand(packageManager);
      if (await needsInstall(startupDirectory.absolutePath)) {
        await this.#run(project.id, command, packageManagerInstallArguments(packageManager), startupDirectory.absolutePath);
      }
      this.#assertCurrent(project.id, operation);

      const port = await availablePort();
      const child = spawn(command, packageManagerRunArguments(project.startupScript ?? "dev", ["--host", "127.0.0.1", "--port", String(port), "--strictPort"]), {
        cwd: startupDirectory.absolutePath,
        env: { ...process.env, BROWSER: "none" },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
        windowsHide: true,
      });
      this.#track(project.id, child);
      this.#running.set(project.id, child);
      const stderr = captureOutput(child.stderr);
      const url = `http://127.0.0.1:${port}`;

      child.once("exit", (code, signal) => {
        this.#untrack(project.id, child);
        if (this.#running.get(project.id) !== child) return;
        this.#running.delete(project.id);
        const error = withOutput(`Preview exited (${signal ?? code ?? "unknown"})`, stderr());
        project.preview = { status: "error", error };
        this.events.publish(project.id, "preview.error", { error });
      });

      await waitUntilReady(url, child, this.#readinessTimeoutMs, stderr);
      this.#assertCurrent(project.id, operation);
      project.preview = { status: "ready", url };
      this.events.publish(project.id, "preview.ready", { url });
      return url;
    } catch (cause) {
      if (this.#operations.get(project.id) === operation) {
        this.#operations.delete(project.id);
        await this.#terminateProject(project.id);
        const error = cause instanceof Error ? cause.message : String(cause);
        project.preview = { status: "error", error };
        this.events.publish(project.id, "preview.error", { error });
      }
      throw cause;
    }
  }

  async stop(project: ProjectState): Promise<void> {
    this.#operations.delete(project.id);
    const hadActivity = this.#children.has(project.id) || project.preview.status !== "stopped";
    await this.#terminateProject(project.id);
    if (!hadActivity) return;
    project.preview = { status: "stopped" };
    this.events.publish(project.id, "preview.stopped", {});
  }

  async stopAll(): Promise<void> {
    this.#operations.clear();
    await Promise.all([...this.#children.keys()].map((projectId) => this.#terminateProject(projectId)));
  }

  async #terminateProject(projectId: string): Promise<void> {
    this.#running.delete(projectId);
    const children = [...(this.#children.get(projectId) ?? [])];
    this.#children.delete(projectId);
    await Promise.all(children.map(terminate));
  }

  async #run(projectId: string, command: string, args: string[], cwd: string): Promise<void> {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.#track(projectId, child);
    try {
      await waitForCommand(child, command);
    } finally {
      this.#untrack(projectId, child);
    }
  }

  #assertCurrent(projectId: string, operation: symbol): void {
    if (this.#operations.get(projectId) !== operation) throw new Error("Preview start superseded");
  }

  #track(projectId: string, child: ChildProcess): void {
    const children = this.#children.get(projectId) ?? new Set<ChildProcess>();
    children.add(child);
    this.#children.set(projectId, children);
  }

  #untrack(projectId: string, child: ChildProcess): void {
    const children = this.#children.get(projectId);
    children?.delete(child);
    if (children?.size === 0) this.#children.delete(projectId);
  }

}

async function needsInstall(workspacePath: string): Promise<boolean> {
  try {
    await access(path.join(workspacePath, "node_modules"));
    return false;
  } catch {
    return true;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcess, timeoutMs: number, stderr: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(withOutput(`Preview exited before ready (${child.exitCode})`, stderr()));
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(withOutput(`Preview did not become ready within ${timeoutMs}ms`, stderr()));
}

function captureOutput(stream: NodeJS.ReadableStream | null): () => string {
  let output = "";
  stream?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-MAX_ERROR_OUTPUT);
  });
  return () => output;
}

function withOutput(message: string, output: string): string {
  const detail = output.trim();
  return detail ? `${message}\n\n${detail}` : message;
}

async function waitForCommand(child: ChildProcess, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await signalProcessTree(child, false);
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 3_000)),
  ]);
  if (timedOut && child.exitCode === null) await signalProcessTree(child, true);
}

async function signalProcessTree(child: ChildProcess, force: boolean): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    else child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
