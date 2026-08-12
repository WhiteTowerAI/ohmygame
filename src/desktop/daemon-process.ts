import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

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
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  healthTimeoutMs?: number;
}

export async function startDaemon(options: StartDaemonOptions): Promise<ManagedDaemon> {
  const port = await availablePort();
  const runtime = { url: `http://127.0.0.1:${port}`, token: options.token };
  const child = spawn(options.executable ?? process.execPath, [path.resolve(options.daemonEntry)], {
    env: {
      ...(options.environment ?? process.env),
      ELECTRON_RUN_AS_NODE: "1",
      DAEMON_HOST: "127.0.0.1",
      DAEMON_PORT: String(port),
      OPEN_GAME_DATA_DIR: path.resolve(options.dataDirectory),
      OPEN_GAME_DAEMON_TOKEN: options.token,
      OPEN_GAME_ALLOWED_ORIGINS: options.allowedOrigins.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let processError: Error | undefined;

  child.stdout?.on("data", (chunk) => process.stdout.write(`[daemon] ${String(chunk)}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[daemon] ${String(chunk)}`));
  child.on("error", (error) => {
    processError = error;
    console.error("Managed daemon process error", error);
  });

  try {
    await waitForHealth(runtime, child, () => processError, options.healthTimeoutMs ?? 15_000);
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
      await stopChild(child);
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
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = processError();
    if (error) throw error;
    if (child.exitCode !== null) throw new Error(`Daemon exited before becoming ready (${child.exitCode})`);
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
  throw new Error(`Daemon did not become ready within ${timeoutMs}ms`);
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
