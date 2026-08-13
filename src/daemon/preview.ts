import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { PreviewLogLine, ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";

interface PreviewOptions {
  readinessTimeoutMs?: number;
  logCapacity?: number;
}

export class PreviewManager {
  readonly #running = new Map<string, ChildProcess>();
  readonly #children = new Map<string, Set<ChildProcess>>();
  readonly #operations = new Map<string, symbol>();
  readonly #logs = new Map<string, PreviewLogLine[]>();
  readonly #readinessTimeoutMs: number;
  readonly #logCapacity: number;
  #nextLogId = 1;

  constructor(
    private readonly events: RuntimeEventBus,
    options: PreviewOptions = {},
  ) {
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    this.#logCapacity = options.logCapacity ?? 500;
  }

  async start(project: ProjectState): Promise<string> {
    const operation = Symbol(project.id);
    this.#operations.set(project.id, operation);
    project.preview = { status: "starting" };
    this.events.publish(project.id, "preview.starting", {});
    await this.#terminateProject(project.id);
    this.#logs.set(project.id, []);

    try {
      this.#assertCurrent(project.id, operation);
      if (await needsInstall(project.workspacePath)) {
        await this.#run(project.id, "npm", ["install", "--no-audit", "--no-fund"], project.workspacePath);
      }
      this.#assertCurrent(project.id, operation);

      const port = await availablePort();
      const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        cwd: project.workspacePath,
        env: { ...process.env, BROWSER: "none" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.#track(project.id, child);
      this.#capture(project.id, child);
      this.#running.set(project.id, child);
      const url = `http://127.0.0.1:${port}`;

      child.once("exit", (code, signal) => {
        this.#untrack(project.id, child);
        if (this.#running.get(project.id) !== child) return;
        this.#running.delete(project.id);
        const error = `Preview exited (${signal ?? code ?? "unknown"})`;
        project.preview = { status: "error", error };
        this.events.publish(project.id, "preview.error", { error });
      });

      await waitUntilReady(url, child, this.#readinessTimeoutMs);
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

  logs(projectId: string): PreviewLogLine[] {
    return [...(this.#logs.get(projectId) ?? [])];
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#track(projectId, child);
    this.#capture(projectId, child);
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

  #capture(projectId: string, child: ChildProcess): void {
    this.#captureStream(projectId, child.stdout, "stdout");
    this.#captureStream(projectId, child.stderr, "stderr");
  }

  #captureStream(projectId: string, stream: NodeJS.ReadableStream | null, source: PreviewLogLine["stream"]): void {
    if (!stream) return;
    let pending = "";
    stream.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.#appendLog(projectId, source, line);
    });
    stream.on("end", () => {
      if (pending) this.#appendLog(projectId, source, pending);
    });
  }

  #appendLog(projectId: string, stream: PreviewLogLine["stream"], text: string): void {
    const line: PreviewLogLine = {
      id: this.#nextLogId++,
      stream,
      text,
      timestamp: new Date().toISOString(),
    };
    const logs = this.#logs.get(projectId) ?? [];
    logs.push(line);
    if (logs.length > this.#logCapacity) logs.splice(0, logs.length - this.#logCapacity);
    this.#logs.set(projectId, logs);
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

async function waitUntilReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview exited before ready (${child.exitCode})`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Preview did not become ready within ${timeoutMs}ms`);
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
  signalProcessTree(child, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      if (child.exitCode === null) signalProcessTree(child, "SIGKILL");
      resolve();
    }, 3_000)),
  ]);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
