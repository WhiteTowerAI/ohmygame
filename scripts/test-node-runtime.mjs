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
  const headers = { authorization: `Bearer ${daemon.runtime.token}`, "content-type": "application/json" };
  const installedResponse = await fetch(`${daemon.runtime.url}/plugins/mcp`, {
    method: "POST", headers, body: JSON.stringify({ name: "node-runtime-fixture", servers: { local: {
      command: process.execPath, args: [path.join(root, "test", "fixtures", "plugin-mcp-server.mjs")],
    } } }), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(installedResponse.status, 201, await installedResponse.text());
  // Retrieve the stable ID after installation through the catalog.
  const catalog = await fetch(`${daemon.runtime.url}/plugins`, { headers }).then(response => response.json());
  const fixture = catalog.plugins.find(plugin => plugin.name === "node-runtime-fixture");
  assert(fixture, "MCP plugin must appear in the Node daemon catalog");
  const tested = await fetch(`${daemon.runtime.url}/plugins/${encodeURIComponent(fixture.id)}/mcp/local/test`, {
    method: "POST", headers, body: "{}", signal: AbortSignal.timeout(30_000),
  });
  assert.equal(tested.status, 200);
  const result = await tested.json();
  assert.equal(result.status, "connected", JSON.stringify(result));
  assert.equal(result.toolCount, 1);
  console.log(
    `Node.js ${process.versions.node}: daemon startup, authenticated API and native MCP runtime passed`,
  );
} finally {
  await daemon?.stop();
  await rm(directory, { recursive: true, force: true });
}
