import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startDaemon } from "../src/desktop/daemon-process.js";

describe("desktop daemon process", () => {
  it("waits for health and stops the managed child", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-desktop-"));
    const pidFile = path.join(directory, "pid");
    const entry = path.join(directory, "daemon.mjs");
    await writeFile(entry, `
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:http";
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      const server = createServer((request, response) => {
        response.statusCode = request.url === "/health" && request.headers.authorization === "Bearer test-token" ? 200 : 401;
        response.end();
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
      healthTimeoutMs: 2_000,
    });
    const pid = Number(await readFile(pidFile, "utf8"));

    expect((await fetch(`${daemon.runtime.url}/health`)).status).toBe(401);
    expect((await fetch(`${daemon.runtime.url}/health`, {
      headers: { authorization: "Bearer test-token" },
    })).status).toBe(200);
    expect(daemon.runtime.token).toBe("test-token");
    await daemon.stop();
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
  });

  it("prepends the packaged runtime to the daemon path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-runtime-"));
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
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
