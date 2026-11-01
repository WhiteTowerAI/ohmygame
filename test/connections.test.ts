import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionService } from "../src/daemon/connections.js";
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
  const connections = new ConnectionService(directory, agentDir, capabilities.configuration, capabilities.host);
  await connections.load();
  return { directory, capabilities, connections };
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
