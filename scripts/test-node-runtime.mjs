import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionHosts } from "../dist/daemon/extension-hosts.js";
import { startDaemon } from "../dist/desktop/daemon-process.js";
import { checkStoryWeb } from "./check-story-web.mjs";

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
  await checkStoryWeb(daemon.runtime);
  const headers = { authorization: `Bearer ${daemon.runtime.token}`, "content-type": "application/json" };
  const projects = await fetch(`${daemon.runtime.url}/projects`, { headers }).then(response => response.json());
  const story = projects.find(project => project.type === "interactive-story");
  assert(story, "The story fixture must exist before checking project archives");
  const exported = await fetch(`${daemon.runtime.url}/projects/${story.id}/export`, {
    method: "POST", headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(exported.status, 200, "Project export must work on Node");
  const imported = await fetch(`${daemon.runtime.url}/projects/import`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/vnd.ohmygame.project-archive" },
    body: await exported.arrayBuffer(), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(imported.status, 201, "Project import must work on Node");
  const copy = await imported.json();
  assert.notEqual(copy.id, story.id);
  assert.equal(copy.type, story.type);
  assert.equal(copy.name, story.name);
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
  await checkExtensionHosts(path.join(directory, "native-plugin"));
} finally {
  await daemon?.stop();
  await rm(directory, { recursive: true, force: true });
}
console.log(
  `Node.js ${process.versions.node}: daemon startup, authenticated API, story creation, upgrade and preview, project export/import, native MCP runtime, extension hosts and graceful shutdown passed`,
);

// The built host runs plugins' native code, and its heap limit holds on Node.
async function checkExtensionHosts(folder) {
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "index.mjs"), `export function activate(context) {
    context.registerTool("ping", (input) => ({ pong: input }));
    context.registerTool("hog", () => { const kept = []; for (;;) kept.push(new Array(1e5).fill(1)); });
  }`);
  const hosts = new ExtensionHosts({ maxHeapMb: 32, crashLimit: 1 });
  const plugin = { id: "check/native", version: "1.0.0", root: folder, entry: "index.mjs", tools: ["ping", "hog"], commands: [], projectTypes: [] };
  try {
    assert.deepEqual(await hosts.invoke({ scope: "app", plugin, tool: "ping", input: 1 }), { pong: 1 });
    const crash = await hosts.invoke({ scope: "app", plugin, tool: "hog", timeoutMs: 20_000 }).then(() => undefined, error => error);
    assert.equal(crash?.code, "crashed", "Running out of heap must crash only the extension host");
    assert.equal(hosts.quarantined("check/native"), true);
  } finally {
    await hosts.dispose();
  }
}
