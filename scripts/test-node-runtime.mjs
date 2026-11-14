import { createAssetGenerationNode } from "../dist/shared/asset-canvas.js";
import { canvasNodeContent } from "../dist/shared/canvas-node-layout.js";
import { PluginIndex } from "../dist/daemon/plugin-index.js";
import { capabilityGrants } from "../dist/daemon/project-plugins.js";
import { prepareSettingsTransaction, resumeSettingsTransaction, SETTINGS_TRANSACTION_FILE, SETTINGS_TRANSACTION_BACKUP } from "../dist/daemon/minimax-settings-transaction.js";
import { snapshot as settingsSnapshot } from "../dist/daemon/minimax-settings-snapshot.js";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const daemonOptions = {
  daemonEntry: path.join(root, "dist", "daemon", "server.js"),
  dataDirectory: path.join(directory, "data"),
  piAgentDirectory: path.join(directory, "pi-agent"),
  token: "node-runtime-check",
  allowedOrigins: [],
};
let daemon;
try {
  const blockedData = path.join(directory, "blocked-data"), blockedPi = path.join(directory, "blocked-pi");
  await mkdir(blockedData);
  const unknownReceipt = JSON.stringify({ version: 2, secret: "do-not-print-recovery-input" });
  await writeFile(path.join(blockedData, SETTINGS_TRANSACTION_FILE), unknownReceipt);
  let unexpected;
  try {
    await assert.rejects(async () => {
      unexpected = await startDaemon({ ...daemonOptions, dataDirectory: blockedData, piAgentDirectory: blockedPi });
    }, (error) => {
      assert.match(error.message, /Unsupported migration journal/);
      assert(!error.message.includes("do-not-print-recovery-input"));
      return true;
    });
  } finally { await unexpected?.stop(); }
  assert.equal(await readFile(path.join(blockedData, SETTINGS_TRANSACTION_FILE), "utf8"), unknownReceipt);
  for (const file of [path.join(blockedPi, "skills"), path.join(blockedData, "plugin-store")])
    await assert.rejects(access(file), { code: "ENOENT" });
  // Simulate a killed migration before the real server loads its settings.
  await mkdir(daemonOptions.dataDirectory, { recursive: true });
  const originalPreferences = JSON.stringify({ version: 1, hidden: {}, future: "keep", disabled: ["minimax-video-cn"] });
  await writeFile(path.join(daemonOptions.dataDirectory, "model-visibility.json"), originalPreferences);
  await prepareSettingsTransaction(daemonOptions.dataDirectory, await settingsSnapshot(daemonOptions.dataDirectory), new Map([
    ["model-visibility.json", Buffer.from(JSON.stringify({ version: 1, hidden: {}, disabled: ["plugin.ohmygame.minimax.cn"] }))],
    ["plugin-store/configuration.json", Buffer.from(JSON.stringify({ version: 1, plugins: {} }))],
  ]));
  await resumeSettingsTransaction(daemonOptions.dataDirectory);
  daemon = await startDaemon(daemonOptions);
  assert.equal(await readFile(path.join(daemonOptions.dataDirectory, "model-visibility.json"), "utf8"), originalPreferences);
  for (const file of [SETTINGS_TRANSACTION_FILE, "plugin-store/configuration.json"])
    await assert.rejects(access(path.join(daemonOptions.dataDirectory, file)), { code: "ENOENT" });
  // Real server entry points must acquire ownership before loading any settings.
  for (const options of [daemonOptions, { ...daemonOptions, dataDirectory: path.join(directory, "other-data") }]) {
    let unexpected;
    try {
      await assert.rejects(async () => { unexpected = await startDaemon(options); }, /data directory is already in use/);
    } finally { await unexpected?.stop(); }
  }
  const health = await fetch(`${daemon.runtime.url}/health`, { headers: { authorization: `Bearer ${daemon.runtime.token}` } });
  assert.equal(health.status, 200, "Rejected contenders must not disturb the running daemon");
  await daemon.stop();
  // An optional, explicitly enabled official package exists before startup.
  // No adapter is run and the canary keys never leave this temporary profile.
  const packageRoot = path.join(daemonOptions.dataDirectory, "plugin-store/packages/ohmygame/minimax/0.1.0");
  await cp(path.join(root, ".runtime/minimax-migration-package/source"), packageRoot, { recursive: true });
  const pluginIndex = new PluginIndex(path.join(daemonOptions.dataDirectory, "plugin-store/index.json"));
  await pluginIndex.load();
  const indexed = await pluginIndex.add(packageRoot);
  assert(indexed.ok);
  await writeFile(path.join(daemonOptions.dataDirectory, "plugin-store/origins.json"), JSON.stringify({ "ohmygame/minimax@0.1.0": { type: "npm", package: "@ohmygame/minimax", version: "0.1.0", registry: "npmjs" } }));
  await writeFile(path.join(daemonOptions.dataDirectory, "plugin-store/grants.json"), JSON.stringify({ schema: 2, plugins: { "ohmygame/minimax": { enabled: true, everyProject: true, allowed: capabilityGrants(indexed.entry.manifest) } }, projects: {} }));
  const legacyKeys = JSON.stringify({ version: 1, cnApiKey: "startup-cn-canary", globalApiKey: "startup-global-canary" });
  await writeFile(path.join(daemonOptions.dataDirectory, "minimax.json"), legacyKeys);
  daemon = await startDaemon(daemonOptions);
  assert.equal(await readFile(path.join(daemonOptions.dataDirectory, "minimax.json"), "utf8"), legacyKeys);
  await access(path.join(daemonOptions.dataDirectory, SETTINGS_TRANSACTION_BACKUP));
  const migrationHeaders = { authorization: `Bearer ${daemon.runtime.token}` };
  const configuration = await fetch(`${daemon.runtime.url}/plugin-store/ohmygame/minimax/configuration`, { headers: migrationHeaders }).then(r => r.json());
  assert.deepEqual(configuration.globalApiKey, { type: "secret", configured: true });
  assert(!JSON.stringify(configuration).includes("canary"));
  const videos = await fetch(`${daemon.runtime.url}/video-models`, { headers: migrationHeaders }).then(r => r.json());
  assert(videos.some(model => model.provider === "plugin.ohmygame.minimax.global"));
  assert(!videos.some(model => model.provider === "plugin.ohmygame.minimax.cn"), "Old provider's disabled choice survives initial cache construction");
  assert(!videos.some(model => model.provider.startsWith("minimax-video-")), "Cutover hides built-in video models");
  const connections = await fetch(`${daemon.runtime.url}/settings/providers`, { headers: migrationHeaders }).then(r => r.json());
  assert(!connections.some(provider => provider.id.startsWith("minimax-video-")), "Cutover hides built-in credential setup");
  const retiredKey = await fetch(`${daemon.runtime.url}/settings/models/providers/minimax-video-global/minimax-key`, { method: "DELETE", headers: migrationHeaders });
  assert.equal(retiredKey.status, 409);
  assert.equal(await readFile(path.join(daemonOptions.dataDirectory, "minimax.json"), "utf8"), legacyKeys);
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
  const canvasBase = `${daemon.runtime.url}/projects/${story.id}/canvas`;
  const workspaceResponse = await fetch(`${canvasBase}/workspace`, { headers });
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json(), boardId = workspace.boards[0].id;
  const boardFile = path.join(story.workspacePath, "canvas", "boards", `${boardId}.json`);
  const layoutFile = path.join(story.workspacePath, "canvas", "editor", `${boardId}.json`);
  const board = JSON.parse(await readFile(boardFile, "utf8")), layoutBefore = await readFile(layoutFile, "utf8");
  const video = createAssetGenerationNode("video", { x: 200, y: 100 });
  video.data.model = { provider: "minimax-video-global", id: "MiniMax-H3" };
  video.data.prompt = "No generation: migrate this saved selection only";
  board.nodes.push(canvasNodeContent(video));
  await writeFile(boardFile, JSON.stringify(board));
  const migratedBoardResponse = await fetch(`${canvasBase}/boards/${boardId}`, { headers });
  assert.equal(migratedBoardResponse.status, 200);
  const migratedBoard = await migratedBoardResponse.json();
  assert.equal(migratedBoard.board.nodes.find(node => node.id === video.id).data.model.provider, "plugin.ohmygame.minimax.global");
  assert.equal(JSON.parse(await readFile(boardFile, "utf8")).nodes.find(node => node.id === video.id).data.model.provider, "plugin.ohmygame.minimax.global");
  assert.equal(await readFile(layoutFile, "utf8"), layoutBefore);

  const projectSettingsFile = path.join(story.workspacePath, ".ohmygame/settings.json");
  const projectSettings = JSON.parse(await readFile(projectSettingsFile, "utf8"));
  const videoDefault = { provider: "plugin.ohmygame.minimax.global", id: "MiniMax-H3" };
  await writeFile(projectSettingsFile, JSON.stringify({ ...projectSettings, future: { keep: "portable" }, mediaModelDefaults: { video: { ...videoDefault, provider: "minimax-video-global" } } }));
  // Export refreshes owned settings and must persist migration before creating the archive.
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
  assert.deepEqual(copy.mediaModelDefaults, { video: videoDefault });
  assert.deepEqual(JSON.parse(await readFile(projectSettingsFile, "utf8")).mediaModelDefaults, { video: videoDefault });
  assert.deepEqual(JSON.parse(await readFile(projectSettingsFile, "utf8")).future, { keep: "portable" });
  const createdResponse = await fetch(`${daemon.runtime.url}/connections`, {
    method: "POST", headers, body: JSON.stringify({ displayName: "Node runtime fixture", definition: {
      command: process.execPath, args: [path.join(root, "test", "fixtures", "plugin-mcp-server.mjs")],
    } }), signal: AbortSignal.timeout(10_000),
  });
  const created = await createdResponse.text();
  assert.equal(createdResponse.status, 201, created);
  const connection = JSON.parse(created);
  const tested = await fetch(`${daemon.runtime.url}/connections/${encodeURIComponent(connection.id)}/test`, {
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
  `Node.js ${process.versions.node}: daemon settings recovery and profile exclusion/restart, authenticated API, story creation, upgrade and preview, project export/import, native MCP runtime, extension hosts and graceful shutdown passed`,
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
