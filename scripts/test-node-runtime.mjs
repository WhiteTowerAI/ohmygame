import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../dist/desktop/daemon-process.js";

assert(
  !process.versions.bun,
  "The application runtime check must execute with Node.js",
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-node-runtime-"));
let daemon;
try {
  daemon = await startDaemon({
    daemonEntry: path.join(root, "dist", "daemon", "server.js"),
    dataDirectory: path.join(directory, "data"),
    piAgentDirectory: path.join(directory, "pi-agent"),
    token: "node-runtime-check",
    allowedOrigins: [],
  });
  const unauthorized = await fetch(`${daemon.runtime.url}/projects`);
  assert.equal(unauthorized.status, 401);
  for (const route of ["/health", "/projects"]) {
    const response = await fetch(`${daemon.runtime.url}${route}`, {
      headers: { authorization: `Bearer ${daemon.runtime.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, `${route} must be available on Node`);
    const body = await response.json();
    if (route === "/projects") assert.deepEqual(body, []);
  }
  console.log(
    `Node.js ${process.versions.node}: daemon startup and authenticated API passed`,
  );
} finally {
  await daemon?.stop();
  await rm(directory, { recursive: true, force: true });
}
