import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startDaemon } from "../src/desktop/daemon-process.js";

describe("desktop daemon process", () => {
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

  it.each([false, true])("waits for health and stops the managed child (development=%s)", async (development) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-desktop-"));
    const pidFile = path.join(directory, "pid");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      const server = createServer((request, response) => {
        response.statusCode = request.url === "/health" && request.headers.authorization === "Bearer test-token" ? 200 : 401;
        response.end(JSON.stringify({ development: process.argv.includes("--dev") }));
      });
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      development,
      healthTimeoutMs: 2_000,
    });
    const pid = Number(await readFile(pidFile, "utf8"));

    expect((await fetch(`${daemon.runtime.url}/health`)).status).toBe(401);
    expect((await fetch(`${daemon.runtime.url}/health`, {
      headers: { authorization: "Bearer test-token" },
    })).status).toBe(200);
    expect(daemon.runtime.token).toBe("test-token");
    expect(await (await fetch(`${daemon.runtime.url}/health`, {
      headers: { authorization: "Bearer test-token" },
    })).json()).toEqual({ development });
    await daemon.stop();
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
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

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

    expect(await readFile(pathFile, "utf8")).toBe(`${runtimeBin}${path.delimiter}/system/bin`);
    await daemon.stop();
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

  it("passes the packaged player directory to the daemon", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-player-path-"));
    const playerDirectory = path.join(directory, "app.asar.unpacked", "dist", "player");
    const playerPathFile = path.join(directory, "player-path");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(playerPathFile)}, process.env.OHMYGAME_PLAYER_DIR ?? "");
      const server = createServer((_request, response) => response.end());
      server.listen(Number(process.env.DAEMON_PORT), "127.0.0.1");
      process.once("SIGTERM", () => server.close(() => process.exit(0)));
    `);

    const daemon = await startDaemon({
      daemonEntry: entry,
      dataDirectory: directory,
      token: "test-token",
      allowedOrigins: ["null"],
      executable: process.execPath,
      environment: {},
      playerDirectory,
      healthTimeoutMs: 2_000,
    });

    expect(await readFile(playerPathFile, "utf8")).toBe(playerDirectory);
    await daemon.stop();
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
        if (message?.channel !== "ohmygame:playtest-response") return;
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(message));
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
