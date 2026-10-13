import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { PlaytestIpcMessage, PlaytestRequest, PlaytestResult } from "../shared/playtest.js";
import { signalProcessTree } from "../daemon/process-lifecycle.js";
import type { DaemonRuntime } from "../shared/desktop-runtime.js";
export type { DaemonRuntime } from "../shared/desktop-runtime.js";

const MAX_STARTUP_OUTPUT_CHARS = 8_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 20_000;

export interface ManagedDaemon {
  runtime: DaemonRuntime;
  stop(): Promise<void>;
}

export interface StartDaemonOptions {
  daemonEntry: string;
  dataDirectory: string;
  token: string;
  allowedOrigins: string[];
  runtimeBin?: string;
  piAgentDirectory?: string;
  bundledPluginsDirectory?: string;
  preinstalledPluginsDirectory?: string;
  examplesDirectory?: string;
  playerDirectory?: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  development?: boolean;
  healthTimeoutMs?: number;
  handlePlaytestRequest?: (request: PlaytestRequest, signal: AbortSignal) => Promise<PlaytestResult>;
  resolveSystemProxy?: () => Promise<string>;
  onUnexpectedExit?: (error: Error) => void;
}

export async function startDaemon(options: StartDaemonOptions): Promise<ManagedDaemon> {
  const port = await availablePort();
  const runtime = { url: `http://127.0.0.1:${port}`, token: options.token };
  const environment = { ...(options.environment ?? process.env) };
  // Also discard inherited tokens, including case variants on Windows.
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "OHMYGAME_DAEMON_TOKEN") delete environment[name];
  }
  if (options.runtimeBin) {
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
    environment[pathKey] = [path.resolve(options.runtimeBin), environment[pathKey]].filter(Boolean).join(path.delimiter);
  }
  const child = spawn(options.executable ?? process.execPath, [path.resolve(options.daemonEntry), ...(options.development ? ["--dev"] : [])], {
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      DAEMON_HOST: "127.0.0.1",
      DAEMON_PORT: String(port),
      OHMYGAME_DATA_DIR: path.resolve(options.dataDirectory),
      OHMYGAME_DAEMON_TOKEN_STDIN: "1",
      OHMYGAME_ALLOWED_ORIGINS: options.allowedOrigins.join(","),
      OHMYGAME_PROJECT_PROCESS_IPC: "1",
      ...(options.piAgentDirectory ? { PI_CODING_AGENT_DIR: path.resolve(options.piAgentDirectory) } : {}),
      ...(options.bundledPluginsDirectory ? { OHMYGAME_BUNDLED_PLUGINS_DIR: path.resolve(options.bundledPluginsDirectory) } : {}),
      ...(options.preinstalledPluginsDirectory ? { OHMYGAME_PREINSTALLED_PLUGINS_DIR: path.resolve(options.preinstalledPluginsDirectory) } : {}),
      ...(options.examplesDirectory ? { OHMYGAME_EXAMPLES_DIR: path.resolve(options.examplesDirectory) } : {}),
      ...(options.playerDirectory ? { OHMYGAME_PLAYER_DIR: path.resolve(options.playerDirectory) } : {}),
      ...(options.handlePlaytestRequest ? { OHMYGAME_PLAYTEST_IPC: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const projectProcesses = new Set<number>();
  child.on("message", (value: unknown) => {
    const message = value as { channel?: unknown; action?: unknown; pid?: unknown } | null;
    if (message?.channel !== "ohmygame:project-process" || typeof message.pid !== "number" || !Number.isSafeInteger(message.pid) || message.pid <= 0) return;
    if (message.action === "started") projectProcesses.add(message.pid);
    else if (message.action === "stopped") projectProcesses.delete(message.pid);
  });
  // The token goes over stdin: other processes of the same user can read the environment a process starts with.
  // Early child exits can close stdin; waitForHealth reports the startup failure and captured output.
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.token);
  if (options.resolveSystemProxy) {
    child.on("message", (value: unknown) => {
      const message = value as { channel?: string; id?: string } | null;
      if (message?.channel !== "ohmygame:system-proxy:resolve" || typeof message.id !== "string" || message.id.length > 100) return;
      const send = (result: { result: string } | { error: string }) => {
        if (child.connected) child.send({ channel: "ohmygame:system-proxy:result", id: message.id, ...result }, () => {});
      };
      void options.resolveSystemProxy!().then((result) => send({ result }), () => send({ error: "Could not detect the system proxy" }));
    });
  }
  const playtestRequests = options.handlePlaytestRequest
    ? bindPlaytestRequests(child, options.handlePlaytestRequest)
    : undefined;
  let processError: Error | undefined;
  let ready = false;
  let stopped = false;
  let startupOutput = "";
  const captureStartupOutput = (chunk: unknown) => {
    startupOutput = `${startupOutput}${String(chunk)}`.slice(-MAX_STARTUP_OUTPUT_CHARS);
  };

  child.stdout?.on("data", (chunk) => {
    captureStartupOutput(chunk);
    process.stdout.write(`[daemon] ${String(chunk)}`);
  });
  child.stderr?.on("data", (chunk) => {
    captureStartupOutput(chunk);
    process.stderr.write(`[daemon] ${String(chunk)}`);
  });
  child.on("error", (error) => {
    processError = error;
    console.error("Managed daemon process error", error);
  });
  const cleanup = async () => {
    playtestRequests?.close();
    const pids = [...projectProcesses];
    projectProcesses.clear();
    await Promise.all(pids.map((pid) => signalProcessTree(pid, true).catch((error) => console.warn("Could not stop project process", error))));
  };
  const closed = new Promise<void>((resolve) => child.once("close", (code, signal) => {
    const unexpected = ready && !stopped;
    void cleanup().finally(() => {
      resolve();
      if (unexpected) options.onUnexpectedExit?.(startupError(`The background service exited (${signal ?? code ?? "unknown"})`, startupOutput));
    });
  }));

  try {
    await waitForHealth(runtime, child, () => processError, () => startupOutput, options.healthTimeoutMs ?? 15_000);
    if (child.exitCode !== null || child.signalCode !== null) throw startupError("Daemon exited during startup", startupOutput);
    ready = true;
  } catch (error) {
    stopped = true;
    await stopChild(child);
    await cleanup();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    runtime,
    stop() {
      if (stopping) return stopping;
      stopped = true;
      return stopping = (async () => {
        playtestRequests?.close();
        await stopChild(child);
        await closed;
      })();
    },
  };
}

function bindPlaytestRequests(
  child: ChildProcess,
  handler: NonNullable<StartDaemonOptions["handlePlaytestRequest"]>,
): { close(): void } {
  const active = new Map<string, AbortController>();
  const send = (message: PlaytestIpcMessage) => {
    if (child.connected) child.send?.(message, () => {});
  };
  const onMessage = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const message = value as Partial<PlaytestIpcMessage> & { id?: unknown };
    if (typeof message.id !== "string") return;
    if (message.channel === "ohmygame:playtest-cancel") {
      active.get(message.id)?.abort();
      return;
    }
    if (message.channel !== "ohmygame:playtest-request" || !("request" in message)) return;
    const controller = new AbortController();
    active.set(message.id, controller);
    void handler(message.request as PlaytestRequest, controller.signal).then(
      (result) => send({ channel: "ohmygame:playtest-response", id: message.id as string, result }),
      (cause) => send({
        channel: "ohmygame:playtest-response",
        id: message.id as string,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ).finally(() => active.delete(message.id as string));
  };
  child.on("message", onMessage);
  return {
    close() {
      child.off("message", onMessage);
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a daemon port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth(
  runtime: DaemonRuntime,
  child: ChildProcess,
  processError: () => Error | undefined,
  startupOutput: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = processError();
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw startupError(`Daemon exited before becoming ready (${child.signalCode ?? child.exitCode})`, startupOutput());
    }
    try {
      const response = await fetch(`${runtime.url}/health`, {
        headers: { authorization: `Bearer ${runtime.token}` },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The daemon may still be binding its socket.
    }
    await delay(100);
  }
  throw startupError(`Daemon did not become ready within ${timeoutMs}ms`, startupOutput());
}

function startupError(message: string, output: string): Error {
  const detail = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return new Error(detail ? `${message}\n\nDaemon output:\n${detail}` : message);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // IPC lets Windows close the daemon's services before taskkill. POSIX also
  // supports older daemons through SIGTERM; both paths share the shutdown gate.
  if (child.connected) child.send({ channel: "ohmygame:shutdown" }, () => {});
  if (process.platform !== "win32") child.kill("SIGTERM");
  if (await exitsWithin(exited, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) return;
  if (process.platform === "win32") await signalProcessTree(child.pid, true);
  else child.kill("SIGKILL");
  if (!(await exitsWithin(exited, 5_000))) {
    throw new Error("The background service could not be stopped.");
  }
}

async function exitsWithin(exited: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
