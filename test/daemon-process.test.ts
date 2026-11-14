import { fork, type ChildProcess } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as shellEnvironment from "../src/daemon/agent-runtimes/environment.js";
import { startDaemon } from "../src/desktop/daemon-process.js";

describe("desktop daemon process", () => {
  it("resolves the system proxy over private child IPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-proxy-ipc-"));
    const entry = path.join(directory, "daemon.mjs");
    const resultFile = path.join(directory, "result.json");
    const shutdownFile = path.join(directory, "shutdown");
    await writeFile(
      entry,
      `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const server = createServer((_request, response) => response.end());
      process.on("message", (message) => {
        if (message.channel === "ohmygame:system-proxy:result") writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(message));
        if (message.channel === "ohmygame:shutdown") server.close(() => {
          writeFileSync(${JSON.stringify(shutdownFile)}, "closed");
          process.exit(0);
        });
      });
      process.send({ channel: "ohmygame:system-proxy:resolve", id: "test-proxy" });
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      // This fixture can only close gracefully through IPC, as on Windows.
      process.once("SIGTERM", () => {});
    `);
    const daemon = await startDaemon({ daemonEntry: entry, dataDirectory: directory, token: "test-token", allowedOrigins: [], executable: process.execPath, environment: {}, resolveSystemProxy: async () => "PROXY 127.0.0.1:7890" });
    try {
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
          channel: "ohmygame:system-proxy:result",
          id: "test-proxy",
          result: "PROXY 127.0.0.1:7890",
        }),
      );
    } finally {
      await Promise.all([daemon.stop(), daemon.stop()]);
      expect(await readFile(shutdownFile, "utf8")).toBe("closed");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "stops a nonresponsive daemon's process tree on Windows",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-daemon-tree-"),
      );
      const entry = path.join(directory, "daemon.mjs");
      const descendantFile = path.join(directory, "descendant.pid");
      await writeFile(
        entry,
        `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(descendantFile)}, String(descendant.pid));
      createServer((_request, response) => response.end()).listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
    `,
      );
      const daemon = await startDaemon({
        daemonEntry: entry,
        dataDirectory: directory,
        token: "test-token",
        allowedOrigins: [],
        executable: process.execPath,
        environment: {},
        gracefulShutdownTimeoutMs: 1_000,
      });
      const descendantPid = Number(await readFile(descendantFile, "utf8"));
      try {
        expect(isRunning(descendantPid)).toBe(true);
        await daemon.stop();
        await vi.waitFor(() => expect(isRunning(descendantPid)).toBe(false));
      } finally {
        if (isRunning(descendantPid)) process.kill(descendantPid);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("includes daemon output when the child exits before becoming healthy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-error-"));
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      process.stderr.write("\\u001b[31mCould not read project metadata\\u001b[0m\\n");
      process.exit(1);
    `);

    await expect(startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      healthTimeoutMs: 2_000,
    })).rejects.toThrow(
      "Daemon exited before becoming ready (1)\n\nDaemon output:\nCould not read project metadata",
    );
  });

  it("writes the daemon's output to its log line by line", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-log-"));
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      process.stdout.write("listening ");
      process.stderr.write("could not read settings\\n");
      process.stdout.write("on 127.0.0.1\\n");
      process.exit(1);
    `);
    const lines: string[] = [];
    const log = {
      line: (text: string) => lines.push(text),
      stream: () => {
        let pending = "";
        return {
          write: (chunk: string | Uint8Array) => {
            pending += String(chunk);
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            lines.push(...parts);
          },
          flush: () => { if (pending) lines.push(pending); pending = ""; },
        };
      },
    };

    await expect(startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      healthTimeoutMs: 2_000,
      log,
    })).rejects.toThrow("Daemon exited before becoming ready");
    await vi.waitFor(() => expect(lines.at(-1)).toBe("OhMyGame service exited (1)"));
    expect(lines[0]).toMatch(/^OhMyGame service starting \(pid \d+\)$/);
    expect(lines).toContain("listening on 127.0.0.1");
    expect(lines).toContain("could not read settings");
    await rm(directory, { recursive: true, force: true });
  });

  it.each([false, true])("waits for health and stops the managed child (development=%s)", async (development) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-"));
    const pidFile = path.join(directory, "pid");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      let token = "";
      for await (const chunk of process.stdin) token += chunk;
      const server = createServer((request, response) => {
        response.statusCode = request.url === "/health" && request.headers.authorization === "Bearer " + token ? 200 : 401;
        response.end(JSON.stringify({ development: process.argv.includes("--dev"), tokenInEnvironment: Object.keys(process.env).some((name) => name.toUpperCase() === "OHMYGAME_DAEMON_TOKEN") }));
      });
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.on("message", (message) => { if (message?.channel === "ohmygame:shutdown") server.close(() => process.exit(0)); });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: { OHMYGAME_DAEMON_TOKEN: "stale-desktop-token", ohmygame_daemon_token: "stale-desktop-token" },
      development,
      healthTimeoutMs: 2_000,
    });
    const pid = Number(await readFile(pidFile, "utf8"));

    try {
      expect((await fetch(`${daemon.runtime.url}/health`)).status).toBe(401);
      expect((await fetch(`${daemon.runtime.url}/health`, {
        headers: { authorization: "Bearer test-token" },
      })).status).toBe(200);
      expect(daemon.runtime.token).toBe("test-token");
      expect(await (await fetch(`${daemon.runtime.url}/health`, {
        headers: { authorization: "Bearer test-token" },
      })).json()).toEqual({ development, tokenInEnvironment: false });
    } finally {
      await daemon.stop();
    }
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
  });

  it("prepends the packaged runtime to the daemon path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-runtime-"));
    const runtimeBin = path.join(directory, "runtime", "node", "bin");
    const pathFile = path.join(directory, "path");
    const entry = path.join(directory, "daemon.mjs");
    await mkdir(runtimeBin, { recursive: true });
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(pathFile)}, process.env.Path ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.on("message", (message) => { if (message?.channel === "ohmygame:shutdown") server.close(() => process.exit(0)); });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    using loginPath = vi.spyOn(shellEnvironment, "loginShellPath").mockResolvedValue("/user/pnpm/bin:.:");
    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: { Path: "/system/bin" },
      runtimeBin,
      healthTimeoutMs: 2_000,
    });

    try {
      const directories = [runtimeBin, "/system/bin"];
      if (process.platform === "darwin") directories.push("/user/pnpm/bin");
      expect(loginPath).toHaveBeenCalledTimes(process.platform === "darwin" ? 1 : 0);
      expect(await readFile(pathFile, "utf8")).toBe(directories.join(path.delimiter));
    } finally {
      await daemon.stop();
    }
  });

  it("passes the OhMyGame Pi agent directory to the daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    const piAgentDirectory = path.join(directory, "pi-agent");
    const piAgentFile = path.join(directory, "pi-agent-path");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(piAgentFile)}, process.env.PI_CODING_AGENT_DIR ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.on("message", (message) => { if (message?.channel === "ohmygame:shutdown") server.close(() => process.exit(0)); });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      piAgentDirectory,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(piAgentFile, "utf8")).toBe(piAgentDirectory);
    await daemon.stop();
  });

  it("passes the log folder to the daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-log-dir-"));
    const logDirectory = path.join(directory, "logs");
    const logDirectoryFile = path.join(directory, "log-dir-path");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(logDirectoryFile)}, process.env.OHMYGAME_LOG_DIR ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.on("message", (message) => { if (message?.channel === "ohmygame:shutdown") server.close(() => process.exit(0)); });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      logDirectory,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(logDirectoryFile, "utf8")).toBe(logDirectory);
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("routes playtest requests over the private child-process channel", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-playtest-ipc-"));
    const resultFile = path.join(directory, "playtest-result");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1", () => {
        process.send({
          channel: "ohmygame:playtest-request",
          id: "request-1",
          request: { operation: "close", sessionId: "session-1" },
        });
      });
      process.on("message", (message) => {
        if (message?.channel === "ohmygame:playtest-response") writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(message));
        if (message?.channel === "ohmygame:shutdown") server.close(() => process.exit(0));
      });
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const handler = vi.fn(async () => ({ operation: "close" as const }));
    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      healthTimeoutMs: 2_000,
      handlePlaytestRequest: handler,
    });

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(resultFile, "utf8"))).toMatchObject({
        channel: "ohmygame:playtest-response",
        id: "request-1",
        result: { operation: "close" },
      });
    });
    expect(handler).toHaveBeenCalledWith(
      { operation: "close", sessionId: "session-1" },
      expect.any(AbortSignal),
    );
    await daemon.stop();
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}


describe("daemon profile ownership", () => {
  const lockName = ".ohmygame-owner-v1.sqlite";
  async function fixture(run: (root: string, start: (directories: string[]) => Promise<{ child: ChildProcess; result: { status: string; message?: string }; closed: Promise<number | null> }>) => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-profile-owner-"));
    const children: { child: ChildProcess; closed: Promise<number | null> }[] = [];
    const start = async (directories: string[]) => {
      const child = fork(path.resolve("test/fixtures/profile-ownership-worker.cjs"), directories, {
        execPath: "node", execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      children.push({ child, closed });
      const result = await new Promise<{ status: string; message?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Profile owner worker did not respond")), 5000);
        child.once("message", (value) => { clearTimeout(timer); resolve(value as { status: string; message?: string }); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Profile owner worker exited before replying")); });
      });
      return { child, result, closed };
    };
    try { await run(root, start); }
    finally {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map(({ closed }) => closed));
      await rm(root, { recursive: true, force: true });
    }
  }

  it("allows exactly one simultaneous process and reacquires after clean shutdown and kill", async () => {
    await fixture(async (root, start) => {
      const folder = path.join(root, "data");
      const pair = await Promise.all([start([folder]), start([folder])]);
      expect(pair.map(({ result }) => result.status).sort()).toEqual(["owned", "rejected"]);
      const winner = pair.find(({ result }) => result.status === "owned")!;
      const loser = pair.find(({ result }) => result.status === "rejected")!;
      expect(loser.result.message).toContain("already in use");
      await loser.closed;
      winner.child.send("close");
      expect(await winner.closed).toBe(0);
      const next = await start([folder]);
      expect(next.result.status).toBe("owned");
      const info = await lstat(path.join(folder, lockName));
      expect(info.size).toBe(0);
      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
      next.child.kill("SIGKILL");
      await next.closed;
      expect((await start([folder])).result.status).toBe("owned");
    });
  });

  it("excludes shared Pi settings and releases an earlier directory when a later acquisition fails", async () => {
    await fixture(async (root, start) => {
      const a = path.join(root, "a"), b = path.join(root, "b"), pi = path.join(root, "pi");
      expect((await start([a, pi])).result.status).toBe("owned");
      const blocked = await start([b, pi]);
      expect(blocked.result.status).toBe("rejected");
      await blocked.closed;
      expect((await start([b, b])).result.status).toBe("owned");
    });
  });

  it("canonicalizes directory aliases without unlinking the owner's lock", async () => {
    await fixture(async (root, start) => {
      const folder = path.join(root, "data"), alias = path.join(root, "alias");
      await mkdir(folder);
      await symlink(folder, alias, process.platform === "win32" ? "junction" : "dir");
      expect((await start([folder, alias])).result.status).toBe("owned");
      const before = await lstat(path.join(folder, lockName));
      const blocked = await start([alias]);
      expect(blocked.result.status).toBe("rejected");
      await blocked.closed;
      const after = await lstat(path.join(folder, lockName));
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(0);
      expect((await start([folder])).result.status).toBe("rejected");
    });
  });

  it.skipIf(process.platform === "win32")("keeps ownership while the process is suspended", async () => {
    await fixture(async (root, start) => {
      const owner = await start([root]);
      expect(owner.result.status).toBe("owned");
      owner.child.kill("SIGSTOP");
      try { expect((await start([root])).result.status).toBe("rejected"); }
      finally { owner.child.kill("SIGCONT"); }
    });
  });

  it("preserves unexpected ownership file contents instead of replacing them", async () => {
    await fixture(async (root, start) => {
      const file = path.join(root, lockName), contents = "future format: preserve me";
      await writeFile(file, contents);
      expect((await start([root])).result).toMatchObject({ status: "rejected", message: expect.stringContaining("Invalid profile ownership file") });
      expect(await readFile(file, "utf8")).toBe(contents);
    });
  });

  it("rejects hardlinked ownership files", async () => {
    await fixture(async (root, start) => {
      const target = path.join(root, "target");
      await writeFile(target, "");
      await link(target, path.join(root, lockName));
      expect((await start([root])).result).toMatchObject({ status: "rejected", message: expect.stringContaining("Invalid profile ownership file") });
      expect((await lstat(target)).nlink).toBe(2);
    });
  });
});
