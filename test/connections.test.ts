import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionService } from "../src/daemon/connections.js";
import { LegacyMcpConfiguration } from "../src/daemon/legacy-mcp.js";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { PluginCapabilities } from "../src/daemon/plugin-capabilities.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-connections-"));
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  const settings = new PluginSettingsStore(directory);
  await settings.load();
  const local = new LocalPluginStore(directory);
  const capabilities = new PluginCapabilities(directory, agentDir, [local], local, settings);
  await capabilities.configuration.load();
  cleanup.push(() => capabilities.host.close());
  const open = async () => {
    const connections = new ConnectionService(directory, agentDir, capabilities.configuration, capabilities.host);
    await connections.load();
    capabilities.movedToConnections = (pluginId, serverId) => connections.moved(pluginId, serverId);
    return connections;
  };
  const connections = await open();
  const source = {
    plugins: async () => (await local.list()).plugins.map((plugin) => settings.decorate(plugin)),
    capabilities,
  };
  return { directory, agentDir, settings, local, capabilities, connections, open, source };
}

describe("connections", () => {
  it("keeps a connection's credentials encrypted and out of what the person reads", async () => {
    const { directory, connections } = await environment();
    const created = await connections.create({
      displayName: "Issue Tracker",
      definition: { url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer tracker-secret" } },
    });
    expect(created).toMatchObject({ id: "issue-tracker", transport: "http", enabled: true, status: "enabled", configurationStatus: "ready" });
    expect(connections.effective().mcpServers).toEqual({
      "connection-issue-tracker": { url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer tracker-secret" }, disabled: false },
    });
    const editable = connections.editableDefinition("issue-tracker");
    expect(JSON.stringify(editable)).not.toContain("tracker-secret");
    expect(editable.headers).toEqual({ Authorization: expect.stringMatching(/^\$\{config\.[a-z0-9-]+\}$/) });
    expect(connections.configurationView("issue-tracker").configuredSecrets).toHaveLength(1);
    for (const file of ["plugin-configuration.json", "connections.json"])
      expect(await readFile(path.join(directory, file), "utf8")).not.toContain("tracker-secret");

    // Saving the masked definition back keeps the credential.
    await connections.setDefinition("issue-tracker", { ...editable, url: "https://tracker.example.com/v2/mcp" });
    expect(connections.effective().mcpServers["connection-issue-tracker"]).toMatchObject({
      url: "https://tracker.example.com/v2/mcp",
      headers: { Authorization: "Bearer tracker-secret" },
    });

    await connections.update("issue-tracker", { enabled: false });
    expect(connections.effective().mcpServers).toEqual({});
    expect((await connections.create({ displayName: "Issue tracker", definition: { command: "node" } })).id).toBe("issue-tracker-2");
    await connections.remove("issue-tracker");
    expect(connections.list().map((item) => item.id)).toEqual(["issue-tracker-2"]);
    expect(() => connections.read("issue-tracker")).toThrow("Connection not found");
  });

  it("rejects fields a manifest couldn't declare and gives simultaneous connections their own ids", async () => {
    const { directory, connections } = await environment();
    await expect(connections.create({
      displayName: "Leaky",
      definition: { command: "leaky" },
      configuration: { token: { type: "secret", label: "Token", default: "credential" } },
    })).rejects.toThrow("Invalid connection configuration");
    expect(await readFile(path.join(directory, "plugin-configuration.json"), "utf8").catch(() => "")).not.toContain("credential");

    const created = await Promise.all([
      connections.create({ displayName: "Tracker", definition: { url: "https://one.example.com/mcp" } }),
      connections.create({ displayName: "Tracker", definition: { url: "https://two.example.com/mcp" } }),
    ]);
    expect(created.map((item) => item.id)).toEqual(["tracker", "tracker-2"]);
    expect(Object.values(connections.effective().mcpServers).map((server) => server.url).sort())
      .toEqual(["https://one.example.com/mcp", "https://two.example.com/mcp"]);
  });

  it("waits for required configuration before a connection runs", async () => {
    const { connections } = await environment();
    await connections.create({
      displayName: "Search",
      definition: { command: "search-mcp", env: { SEARCH_REGION: "${config.region}" } },
      configuration: { region: { type: "text", label: "Region", required: true } },
    });
    expect(connections.read("search")).toMatchObject({ status: "not-configured", configurationStatus: "needs-configuration" });
    expect(connections.effective().mcpServers).toEqual({});
    await connections.saveConfiguration("search", { region: "eu" });
    expect(connections.effective().mcpServers["connection-search"]).toMatchObject({ env: { SEARCH_REGION: "eu" } });
  });

  it("moves the old mcp.json servers here under their old names, once", async () => {
    const { agentDir, capabilities, connections, open, source } = await environment();
    const original = {
      command: "node",
      args: ["server.js"],
      cwd: "/opt/example",
      env: { TOKEN: "old-secret" },
      disabled: true,
      auth: "oauth",
      oauth: { clientId: "client", clientSecret: "secret" },
      includeTools: ["echo"],
      lifecycle: "eager",
    };
    await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { example: original, docs: { url: "https://docs.example.com/mcp" } } }));
    await capabilities.migrate(new LegacyMcpConfiguration(agentDir));
    expect(await connections.migrate(source)).toEqual([]);

    const moved = connections.list();
    expect(moved.map((item) => [item.id, item.displayName, item.enabled])).toEqual([["docs", "docs", true], ["example", "example", false]]);
    const { disabled: _disabled, ...template } = original;
    await connections.update("example", { enabled: true });
    // Its runtime name is the one its OAuth sign-in is stored by.
    expect(connections.effective().mcpServers).toEqual({
      example: { ...template, disabled: false },
      docs: { url: "https://docs.example.com/mcp", disabled: false },
    });
    // The plugins still exist for an older app, but no longer run their servers.
    expect((await capabilities.effective()).mcpServers).toEqual({});

    // A deleted connection stays deleted, also after a restart.
    await connections.remove("docs");
    const reopened = await open();
    expect(await reopened.migrate(source)).toEqual([]);
    expect(reopened.list().map((item) => item.id)).toEqual(["example"]);
  });

  it("leaves marketplace plugins' MCP servers in their plugins", async () => {
    const { directory, local, capabilities, connections, source } = await environment();
    const folder = path.join(directory, "community-tool");
    await mkdir(path.join(folder, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      name: "community-tool", version: "1.0.0", description: "A marketplace MCP server", mcpServers: "./mcp.json",
    }));
    await writeFile(path.join(folder, "mcp.json"), JSON.stringify({ mcpServers: { api: { url: "https://community.example.com/mcp" } } }));
    const plugin = await local.install(folder, undefined, undefined, { id: "community", displayName: "Community" });
    expect(await connections.migrate(source)).toEqual([]);
    expect(connections.list()).toEqual([]);
    expect(capabilities.movedToConnections(plugin.id, "api")).toBe(false);
  });

  it("never gives a new connection the runtime name a moved server kept", async () => {
    const { agentDir, capabilities, connections, source } = await environment();
    await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "connection-docs": { url: "https://old.example.com/mcp" } } }));
    await capabilities.migrate(new LegacyMcpConfiguration(agentDir));
    // Also while that server hasn't moved yet.
    expect((await connections.create({ displayName: "Docs", definition: { url: "https://new.example.com/mcp" } })).id).toBe("docs-2");
    expect(await connections.migrate(source)).toEqual([]);
    expect(connections.effective().mcpServers).toEqual({
      "connection-docs": { url: "https://old.example.com/mcp", disabled: false },
      "connection-docs-2": { url: "https://new.example.com/mcp", disabled: false },
    });
  });

  it("keeps a working directory outside the plugin's folder where it was", async () => {
    const { directory, capabilities, connections, source } = await environment();
    const plugin = await capabilities.create({
      name: "shared-tools",
      servers: {
        tools: { command: "node", args: ["server.mjs"], cwd: "../shared" },
        configured: { command: "node", args: ["server.mjs"], cwd: "${config.folder}" },
        absolute: { command: "node", args: ["server.mjs"], cwd: "${config.place}" },
      },
      configuration: { folder: { type: "text", label: "Folder" }, place: { type: "text", label: "Place" } },
    });
    const installed = (await capabilities.all()).find((item) => item.id === plugin.id)!;
    await capabilities.configuration.update(installed, { folder: "../other", place: path.join(directory, "elsewhere") });
    const root = await capabilities.packageRoot(installed);
    expect(await connections.migrate(source)).toEqual([]);
    const servers = connections.effective().mcpServers;
    expect(servers[capabilities.runtimeName(plugin.id, "tools")]!.cwd).toBe(path.resolve(root, "../shared"));
    expect(servers[capabilities.runtimeName(plugin.id, "configured")]!.cwd).toBe(path.resolve(root, "../other"));
    // A value changed later still resolves against the plugin's folder.
    const absolute = connections.list().find((item) => item.migratedFrom?.serverId === "absolute")!;
    await connections.saveConfiguration(absolute.id, { place: "../later" });
    expect(connections.effective().mcpServers[capabilities.runtimeName(plugin.id, "absolute")]!.cwd).toBe(path.resolve(root, "../later"));
    // Also when it pointed inside at first, and a folder inside uses the copy.
    const configured = connections.list().find((item) => item.migratedFrom?.serverId === "configured")!;
    await connections.saveConfiguration(configured.id, { folder: "lib" });
    expect(connections.effective().mcpServers[capabilities.runtimeName(plugin.id, "configured")]!.cwd).toBe(path.join(directory, "connections", configured.id, "lib"));
    await connections.saveConfiguration(configured.id, { folder: "../again" });
    expect(connections.effective().mcpServers[capabilities.runtimeName(plugin.id, "configured")]!.cwd).toBe(path.resolve(root, "../again"));
  });

  it("never moves a server onto a connection that already has its fallback id", async () => {
    const { capabilities, connections, source } = await environment();
    const fallback = `docs-${createHash("sha256").update("personal:incoming/api").digest("hex").slice(0, 6)}`;
    await connections.create({ displayName: "Docs", definition: { url: "https://docs.example.com/mcp" } });
    await connections.create({ displayName: fallback, definition: { url: "https://other.example.com/mcp" } });
    await capabilities.create({ name: "incoming", displayName: "Docs", servers: { api: { url: "https://incoming.example.com/mcp" } } });
    expect(await connections.migrate(source)).toEqual([]);
    expect(connections.list().map((item) => item.id).sort()).toEqual(["docs", fallback, `${fallback}-2`]);
    expect(Object.values(connections.effective().mcpServers).map((server) => server.url).sort())
      .toEqual(["https://docs.example.com/mcp", "https://incoming.example.com/mcp", "https://other.example.com/mcp"]);
  });

  it("moves an MCP plugin's edited definition, credentials and files, leaving the plugin as it was", async () => {
    const { directory, settings, capabilities, connections, source } = await environment();
    const plugin = await capabilities.create({
      name: "local-tools",
      displayName: "Local tools",
      servers: { tools: { command: "node", args: ["server.mjs"], env: { API_TOKEN: "local-secret" } } },
    });
    const installed = (await capabilities.all()).find((item) => item.id === plugin.id)!;
    await writeFile(path.join(await capabilities.packageRoot(installed), "server.mjs"), "// fixture\n");
    const editable = await capabilities.editableTemplate(installed, "tools");
    await capabilities.setDefinition(installed, "tools", { ...editable, args: ["server.mjs", "--verbose"] });
    await settings.update(installed, { enabled: true, components: settings.resolve(installed).components });
    const before = await capabilities.definition(installed, "tools");
    const runtimeName = capabilities.runtimeName(plugin.id, "tools");

    expect(await connections.migrate(source)).toEqual([]);
    expect(connections.list()).toEqual([
      expect.objectContaining({ id: "local-tools", displayName: "Local tools", transport: "stdio", enabled: true, migratedFrom: { type: "plugin", pluginId: plugin.id, serverId: "tools" } }),
    ]);
    const moved = connections.effective().mcpServers[runtimeName]!;
    expect(moved).toMatchObject({ command: "node", args: ["server.mjs", "--verbose"], env: { API_TOKEN: "local-secret" } });
    // The command runs in a copy of the plugin's folder.
    expect(moved.cwd).toBe(path.join(directory, "connections", "local-tools"));
    expect(await readFile(path.join(moved.cwd as string, "server.mjs"), "utf8")).toBe("// fixture\n");
    // The plugin keeps its own configuration.
    expect(await capabilities.definition(installed, "tools")).toEqual(before);
    expect(capabilities.movedToConnections(plugin.id, "tools")).toBe(true);
  });

  it("finishes an interrupted move on the next start without duplicating it", async () => {
    const { capabilities, connections, open, source } = await environment();
    await capabilities.create({ name: "remote", servers: { api: { url: "https://remote.example.com/mcp" } } });
    const copy = vi.spyOn(capabilities.configuration, "copyOwner").mockRejectedValueOnce(new Error("Interrupted write"));
    const failures = await connections.migrate(source);
    expect(failures).toEqual([expect.objectContaining({ pluginId: "personal:remote", serverId: "api" })]);
    expect(connections.list()).toEqual([]);
    expect(capabilities.movedToConnections("personal:remote", "api")).toBe(false);
    copy.mockRestore();
    const reopened = await open();
    expect(await reopened.migrate(source)).toEqual([]);
    expect(await reopened.migrate(source)).toEqual([]);
    expect(reopened.list().map((item) => item.id)).toEqual(["remote"]);
  });

  it("connects through the MCP host with its credentials and keeps them out of the result", async () => {
    const { capabilities, connections } = await environment();
    let authorization = "";
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      authorization = String(req.headers.authorization ?? "");
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
        : { tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    await connections.create({ displayName: "Fixture", definition: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer fixture-secret" } } });
    const result = await connections.test("fixture");
    expect(result).toMatchObject({ status: "connected", toolCount: 1 });
    expect(authorization).toBe("Bearer fixture-secret");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");

    // A credential replaced while a test runs stays masked in what that test returns.
    const probe = vi.spyOn(capabilities.host, "probe").mockImplementationOnce(async () => {
      const [key] = connections.configurationView("fixture").configuredSecrets;
      await connections.saveConfiguration("fixture", { [key!]: "replacement-secret" });
      return { status: "failed" as const, toolCount: 0, message: "Server said: Bearer fixture-secret" };
    });
    expect((await connections.test("fixture")).message).not.toContain("fixture-secret");
    probe.mockRestore();
  }, 45_000);
});
