import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { PlaytestIpcMessage, PlaytestRequest, PlaytestResult } from "../shared/playtest.js";

const MAX_STARTUP_OUTPUT_CHARS = 8_000;

export interface DaemonRuntime {
  url: string;
  token: string;
}

export interface ManagedDaemon {
  runtime: DaemonRuntime;
  stop(): Promise<void>;
}

interface StartDaemonOptions {
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
}

export async function startDaemon(options: StartDaemonOptions): Promise<ManagedDaemon> {
  const port = await availablePort();
  const runtime = { url: `http://127.0.0.1:${port}`, token: options.token };
  const environment = { ...(options.environment ?? process.env) };
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
      ...(options.piAgentDirectory ? { PI_CODING_AGENT_DIR: path.resolve(options.piAgentDirectory) } : {}),
      ...(options.bundledPluginsDirectory ? { OHMYGAME_BUNDLED_PLUGINS_DIR: path.resolve(options.bundledPluginsDirectory) } : {}),
      ...(options.preinstalledPluginsDirectory ? { OHMYGAME_PREINSTALLED_PLUGINS_DIR: path.resolve(options.preinstalledPluginsDirectory) } : {}),
      ...(options.examplesDirectory ? { OHMYGAME_EXAMPLES_DIR: path.resolve(options.examplesDirectory) } : {}),
      ...(options.playerDirectory ? { OHMYGAME_PLAYER_DIR: path.resolve(options.playerDirectory) } : {}),
      ...(options.handlePlaytestRequest ? { OHMYGAME_PLAYTEST_IPC: "1" } : {}),
    },
    stdio: options.handlePlaytestRequest || options.resolveSystemProxy ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
  });
  // The token goes over stdin: other processes of the same user can read the environment a process starts with.
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

  try {
    await waitForHealth(runtime, child, () => processError, () => startupOutput, options.healthTimeoutMs ?? 15_000);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  let stopped = false;
  return {
    runtime,
    async stop() {
      if (stopped) return;
      stopped = true;
      playtestRequests?.close();
      await stopChild(child);
    },
  };
}

function bindPlaytestRequests(
  child: ChildProcess,
  handler: NonNullable<StartDaemonOptions["handlePlaytestRequest"]>,
): { close(): void } {
  const active = new Map<string, AbortController>();
  const send = (message: PlaytestIpcMessage) => {
    if (child.connected) child.send?.(message);
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
    if (child.exitCode !== null) {
      throw startupError(`Daemon exited before becoming ready (${child.exitCode})`, startupOutput());
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
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const forced = await Promise.race([exited.then(() => false), delay(5_000).then(() => true)]);
  if (forced && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
