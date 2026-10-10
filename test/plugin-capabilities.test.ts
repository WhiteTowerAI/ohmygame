import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginCapabilities } from "../src/daemon/plugin-capabilities.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";
import { LegacyMcpConfiguration } from "../src/daemon/legacy-mcp.js";
import { createApp } from "../src/daemon/app.js";
import { PluginSetupManager } from "../src/daemon/plugin-setup.js";
import {
  LocalPluginAdapter,
  PluginCatalogService,
} from "../src/daemon/plugin-catalog.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function environment() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-capabilities-"),
  );
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  const settings = new PluginSettingsStore(directory);
  await settings.load();
  const local = new LocalPluginStore(directory);
  const bundled = new BundledPluginStore(path.resolve("plugins"));
  await bundled.load();
  const service = new PluginCapabilities(
    directory,
    agentDir,
    [bundled, local],
    local,
    settings,
  );
  await service.configuration.load();
  cleanup.push(() => service.host.close());
  return { directory, agentDir, settings, local, bundled, service };
}
describe("native plugin capabilities", () => {
  it("reads credential masks without writes and preserves them on an explicit save", async () => {
    const { service, local, directory } = await environment();
    const source = path.join(directory, "raw-service");
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(
      path.join(source, ".ohmygame-plugin/plugin.json"),
      JSON.stringify({
        name: "raw-service",
        version: "1.0.0",
        description: "Imported package",
        mcpServers: "./mcp.json",
      }),
    );
    await writeFile(
      path.join(source, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          api: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer packaged-secret" },
          },
        },
      }),
    );
    const plugin = await local.install(source);
    const template = await service.editableTemplate(plugin, "api");
    expect(JSON.stringify(template)).not.toContain("packaged-secret");
    await expect(
      readFile(service.configuration.filePath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.configuration.view(plugin).fields).toEqual({});
    const probe = vi.spyOn(service.host, "probe");
    probe.mockRejectedValueOnce(new Error("Rejected token packaged-secret"));
    await expect(service.test(plugin, "api")).rejects.toThrow(
      "Rejected token [redacted]",
    );
    probe.mockResolvedValueOnce({
      status: "failed",
      toolCount: 0,
      message: "Invalid packaged-secret",
    });
    expect((await service.test(plugin, "api")).message).toBe(
      "Invalid [redacted]",
    );
    await service.setDefinition(
      plugin,
      "api",
      { ...template, lifecycle: "lazy" },
      false,
    );
    expect(await service.definition(plugin, "api")).toMatchObject({
      headers: { Authorization: "Bearer packaged-secret" },
      lifecycle: "lazy",
    });
    vi.spyOn(service.host, "probe").mockRejectedValueOnce(
      new Error("Rejected token packaged-secret"),
    );
    await expect(service.test(plugin, "api")).rejects.toThrow(
      "Rejected token [redacted]",
    );
  });

  it("cleans generated fields after editing one service without losing another service's credentials", async () => {
    const { service, local } = await environment();
    const plugin = await service.create({
      name: "pruned-fields",
      servers: {
        alpha: { url: "https://alpha.example/mcp" },
        beta: { url: "https://beta.example/mcp" },
      },
    });
    await Promise.all([
      service.setDefinition(plugin, "alpha", {
        url: "https://alpha.example/mcp",
        headers: { Authorization: "alpha-secret" },
      }),
      service.setDefinition(plugin, "beta", {
        url: "https://beta.example/mcp",
        headers: { Authorization: "beta-secret" },
      }),
    ]);
    const alphaKey = service.configuration
      .view(plugin)
      .configuredSecrets.find((key) => key.startsWith("alpha"))!;
    await service.configuration.update(plugin, { [alphaKey]: null });
    expect(service.configuration.view(plugin).missing).toContain(alphaKey);
    await Promise.all([
      service.setDefinition(plugin, "alpha", {
        url: "https://alpha.example/mcp",
      }),
      service.setDefinition(plugin, "beta", {
        url: "https://beta.example/updated",
        headers: { Authorization: "new-beta-secret" },
      }),
    ]);
    expect(service.configuration.view(plugin).fields).not.toHaveProperty(
      alphaKey,
    );
    expect(service.configuration.view(plugin).missing).toEqual([]);
    expect(await service.definition(plugin, "beta")).toMatchObject({
      headers: { Authorization: "new-beta-secret" },
    });
    const lookup = vi.spyOn(local, "installedPath");
    await service.decorate(plugin);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("allows public environment and header values through AI authoring while protecting credentials", async () => {
    const { service } = await environment();
    const plugin = await service.create(
      {
        name: "public-values",
        servers: {
          local: {
            command: "node",
            env: { NODE_ENV: "production", LOG_LEVEL: "info" },
          },
          api: {
            url: "https://example.com/mcp",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
          },
        },
      },
      false,
    );
    expect(service.configuration.view(plugin).fields).toEqual({});
    await expect(
      service.setDefinition(
        plugin,
        "api",
        {
          url: "https://example.com/mcp",
          headers: { Authorization: "private" },
        },
        false,
      ),
    ).rejects.toThrow("secret configuration field");
  });

  it("recovers credentials when migration was interrupted after package installation", async () => {
    const { service, local, agentDir } = await environment();
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          recoverable: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer recover-me" },
            disabled: true,
          },
        },
      }),
    );
    const interrupted = vi
      .spyOn(service.configuration, "update")
      .mockRejectedValueOnce(new Error("Interrupted write"));
    const legacy = new LegacyMcpConfiguration(agentDir);
    await expect(service.migrate(legacy)).rejects.toThrow("Interrupted write");
    interrupted.mockRestore();
    expect((await local.list()).plugins).toHaveLength(1);
    await service.migrate(legacy);
    const owner = service.configuration.legacyOwners.recoverable!;
    const plugin = (await service.all()).find(
      (item) => item.id === owner.pluginId,
    )!;
    expect(plugin.enabled).toBe(false);
    expect(await service.definition(plugin, owner.serverId)).toMatchObject({
      headers: { Authorization: "Bearer recover-me" },
    });
    expect((await local.list()).plugins).toHaveLength(1);
  });

  it("tracks model lookup during assistant shutdown and persists lookup failures", async () => {
    const { service, local, directory, agentDir, settings } =
      await environment();
    let rejectModel!: (cause: Error) => void;
    const resolveModel = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectModel = reject;
        }),
    );
    const manager = new PluginSetupManager(
      directory,
      agentDir,
      service,
      new PluginCatalogService([new LocalPluginAdapter(local)], settings),
      local,
      () => {},
      resolveModel,
    );
    cleanup.push(() => manager.close());
    const state = await manager.create();
    await manager.prompt(state.id, {
      prompt: "Set up a plugin",
      model: { provider: "fixture", id: "fixture" },
    });
    expect((await manager.read(state.id)).busy).toBe(true);
    let closed = false;
    const closing = manager.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    rejectModel(new Error("Provider lookup failed"));
    await closing;
    expect(await manager.read(state.id)).toMatchObject({
      busy: false,
      error: "Provider lookup failed",
    });
  });
  it("keeps secrets out of packages and API views, preserves configuration on reinstall, and applies plugin/server switches", async () => {
    const { service, local, settings, directory } = await environment();
    const plugin = await service.create({
      name: "secure-service",
      servers: {
        api: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer private-token" },
          oauth: { clientSecret: "private-client" },
          lifecycle: "lazy-keep-alive",
          includeTools: ["echo"],
        },
      },
    });
    const config = service.configuration.view(plugin);
    expect(config.configuredSecrets).toHaveLength(2);
    expect(JSON.stringify(config)).not.toContain("private-token");
    expect(
      service.configuration.redact(plugin, "Invalid token private-token"),
    ).toBe("Invalid token [redacted]");
    expect(
      await readFile(
        path.join((await local.installedPath(plugin.id))!, "mcp.json"),
        "utf8",
      ),
    ).not.toContain("private-token");
    expect(
      await readFile(service.configuration.filePath, "utf8"),
    ).not.toContain("private-client");
    expect(
      (await service.effective()).mcpServers[
        service.runtimeName(plugin.id, "api")
      ],
    ).toMatchObject({
      headers: { Authorization: "Bearer private-token" },
      includeTools: ["echo"],
    });
    await local.install(
      path.join(directory, "plugin-workspaces", "secure-service"),
    );
    expect(
      service.configuration.view((await local.read(plugin.id))!)
        .configuredSecrets,
    ).toEqual(config.configuredSecrets);
    await settings.update(plugin, {
      enabled: true,
      components: { "mcp:api": false },
    });
    expect((await service.effective()).mcpServers).not.toHaveProperty(
      service.runtimeName(plugin.id, "api"),
    );
    await settings.update(plugin, {
      enabled: false,
      components: { "mcp:api": true },
    });
    expect((await service.effective()).mcpServers).not.toHaveProperty(
      service.runtimeName(plugin.id, "api"),
    );
  });
  it("installs incomplete configuration, then resolves templates after configuration without exposing secrets", async () => {
    const { service } = await environment();
    const plugin = await service.create({
      name: "needs-key",
      servers: {
        api: {
          url: "${config.endpoint}",
          headers: { Authorization: "Bearer ${config.key}" },
        },
      },
      configuration: {
        endpoint: { type: "text", label: "Endpoint", required: true },
        key: { type: "secret", label: "API key", required: true },
      },
    });
    expect((await service.decorate(plugin)).mcpServers?.[0]?.status).toBe(
      "not-configured",
    );
    await service.configuration.update(plugin, {
      endpoint: "https://example.com/mcp",
      key: "the-secret",
    });
    expect(await service.definition(plugin, "api")).toMatchObject({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer the-secret" },
    });
    await expect(
      service.configuration.update(plugin, { key: "bad" }, false),
    ).rejects.toThrow("configuration form");
  });
  it("edits multiple MCP definitions atomically and reloads the masked configuration after restart", async () => {
    const { service, directory, agentDir, local, bundled, settings } =
      await environment();
    const plugin = await service.create({
      name: "editable",
      servers: {
        alpha: { url: "https://alpha.example/mcp" },
        beta: { url: "https://beta.example/mcp" },
      },
    });
    await Promise.all([
      service.setDefinition(plugin, "alpha", {
        url: "https://alpha.example/mcp",
        headers: { Authorization: "Bearer alpha-secret" },
        lifecycle: "eager",
      }),
      service.setDefinition(plugin, "beta", {
        url: "https://beta.example/mcp",
        headers: { Authorization: "Bearer beta-secret" },
      }),
    ]);
    const config = service.configuration.view(plugin);
    expect(config.configuredSecrets).toHaveLength(2);
    expect(
      JSON.stringify(await service.editableTemplate(plugin, "alpha")),
    ).not.toContain("alpha-secret");
    const restored = new PluginCapabilities(
      directory,
      agentDir,
      [bundled, local],
      local,
      settings,
    );
    await restored.configuration.load();
    cleanup.push(() => restored.host.close());
    expect(await restored.definition(plugin, "alpha")).toMatchObject({
      headers: { Authorization: "Bearer alpha-secret" },
      lifecycle: "eager",
    });
    expect(await restored.definition(plugin, "beta")).toMatchObject({
      headers: { Authorization: "Bearer beta-secret" },
    });
    await restored.configuration.update(plugin, {
      [config.configuredSecrets.find((key) => key.startsWith("alpha"))!]: null,
    });
    const effective = await restored.effective();
    expect(effective.mcpServers).not.toHaveProperty(
      restored.runtimeName(plugin.id, "alpha"),
    );
    expect(effective.mcpServers).toHaveProperty(
      restored.runtimeName(plugin.id, "beta"),
    );
  });

  it("migrates full legacy definitions once with stable IDs, disabled state and a backup", async () => {
    const { service, directory, agentDir } = await environment();
    const original = {
      mcpServers: {
        example: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "old-secret" },
          disabled: true,
          auth: "oauth",
          oauth: { clientId: "client", clientSecret: "secret" },
          includeTools: ["echo"],
          lifecycle: "eager",
        },
      },
    };
    await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(original));
    const manager = new LegacyMcpConfiguration(agentDir);
    await service.migrate(manager);
    const owner = service.configuration.legacyOwners.example!;
    const plugin = (await service.all()).find((p) => p.id === owner.pluginId)!;
    expect(plugin.enabled).toBe(false);
    expect(service.runtimeName(plugin.id, owner.serverId)).toBe("example");
    expect(await service.definition(plugin, owner.serverId)).toEqual(
      original.mcpServers.example,
    );
    await service.configuration.update(plugin, {});
    await service.migrate(manager);
    expect(
      (await service.all()).filter((p) => p.id === owner.pluginId),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(path.join(agentDir, "mcp.json.pre-plugins.bak"), "utf8"),
      ).mcpServers.example,
    ).toEqual(original.mcpServers.example);
    expect(
      await readFile(path.join(directory, "plugin-configuration.json"), "utf8"),
    ).not.toContain("old-secret");
  });
  it("connects to a real STDIO server, lists tools and shuts the process down", async () => {
    const { service, directory } = await environment();
    const pidFile = path.join(directory, "server.pid");
    const plugin = await service.create({
      name: "stdio-fixture",
      servers: {
        local: {
          command: process.execPath,
          args: [path.resolve("test/fixtures/plugin-mcp-server.mjs"), pidFile],
        },
      },
    });
    const result = await service.test(plugin, "local");
    expect(result).toMatchObject({ status: "connected", toolCount: 1 });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 45_000);
  it("tests HTTP using resolved credentials and returns a sanitized result", async () => {
    const { service } = await environment();
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
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1.0.0" },
            }
          : { tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address() as { port: number };
    const plugin = await service.create({
      name: "http-fixture",
      servers: {
        api: {
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: "Bearer test-secret" },
        },
      },
    });
    const result = await service.test(plugin, "api");
    expect(result).toMatchObject({ status: "connected", toolCount: 1 });
    expect(authorization).toBe("Bearer test-secret");
    expect(JSON.stringify(result)).not.toContain("test-secret");
  }, 45_000);
  it("executes real MCP tools through a plugin session and keeps an independent provider enabled", async () => {
    const { service, settings, directory, local } = await environment();
    const provider = await service.create({
      name: "provider",
      servers: {
        local: {
          command: process.execPath,
          args: [path.resolve("test/fixtures/plugin-mcp-server.mjs")],
        },
      },
    });
    await service.configuration.setLegacyOwner(
      "shared-local",
      provider.id,
      "local",
    );
    const source = path.join(directory, "consumer");
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(
      path.join(source, ".ohmygame-plugin", "plugin.json"),
      JSON.stringify({
        name: "consumer",
        version: "1.0.0",
        description: "Uses a shared provider",
        connections: ["shared-local", "missing-provider"],
      }),
    );
    const consumer = await local.install(source);
    await settings.update(consumer, { enabled: false, components: {} });
    const config = await service.effective("web-game");
    expect(config.mcpServers).toHaveProperty("shared-local");
    expect(config.mcpServers).not.toHaveProperty("ohmygame-godot");
    expect((await service.decorate(consumer)).connections).toMatchObject([
      { id: "shared-local", ownerPluginId: provider.id, status: "enabled" },
      { id: "missing-provider", status: "not-configured" },
    ]);
    const settingsManager = SettingsManager.inMemory({ packages: [] });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [
        { name: "plugin-mcp", factory: await service.host.extension(config) },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      resourceLoader: loader,
      noTools: "builtin",
      sessionManager: SessionManager.inMemory(directory),
    });
    const close = service.host.manage(session);
    try {
      await session.bindExtensions({ mode: "rpc" });
      const mcp = session.getToolDefinition("mcp")!;
      const result = await mcp.execute(
        "echo-call",
        {
          server: "shared-local",
          tool: "shared-local_echo",
          args: { value: "actual tool result" },
        },
        undefined,
        undefined,
        session.extensionRunner.createToolContext("echo-call", undefined),
      );
      expect(JSON.stringify(result)).toContain("actual tool result");
      expect(service.host.status("shared-local")).toMatchObject({
        status: "connected",
        toolCount: 1,
      });
    } finally {
      await close();
    }
    expect(service.host.status("shared-local")).toBeUndefined();
  });

  it("runs a persistent plugin assistant through a model tool call without a game project", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-setup-model-"),
    );
    let requests = 0,
      receivedToolResult = false;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      receivedToolResult ||= payload.messages.some(
        (m: { role: string }) => m.role === "tool",
      );
      const delta =
        requests++ === 0
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "plugin-tool-call",
                  type: "function",
                  function: {
                    name: "plugin_manage",
                    arguments: JSON.stringify({
                      action: "create-mcp",
                      input: {
                        name: "ai-created",
                        servers: { api: { url: "https://example.com/mcp" } },
                      },
                    }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: "Created the MCP plugin. Configure it in Plugins.",
            };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      modelsStorePath: path.join(directory, "catalog.json"),
      allowModelNetwork: false,
    });
    const app = createApp({
      dataDirectory: directory,
      piAgentDirectory: directory,
      createModelRuntime: async () => runtime,
    });
    cleanup.push(() => app.close());
    const created = await app.inject({
      method: "POST",
      url: "/settings/models/providers/custom",
      payload: {
        name: "Fixture model",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        api: "openai-completions",
        authentication: "api_key",
        apiKey: "fixture",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            api: "openai-completions",
            contextWindow: 32_000,
            maxTokens: 4_000,
            reasoning: false,
            supportsImages: false,
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const state = (
      await app.inject({
        method: "POST",
        url: "/plugins/setup-sessions",
        payload: {},
      })
    ).json();
    const prompt = await app.inject({
      method: "POST",
      url: `/plugins/setup-sessions/${state.id}/prompt`,
      payload: {
        prompt: "Create an MCP plugin",
        model: { provider: created.json().id, id: "fixture" },
      },
    });
    expect(prompt.statusCode, prompt.body).toBe(202);
    await vi.waitFor(
      async () => {
        const current = (
          await app.inject({
            method: "GET",
            url: `/plugins/setup-sessions/${state.id}`,
          })
        ).json();
        expect(current.busy).toBe(false);
        expect(current.error).toBeUndefined();
        expect(current.pluginId).toBe("personal:ai-created");
        expect(current.messages).toContainEqual({
          role: "assistant",
          text: "Created the MCP plugin. Configure it in Plugins.",
        });
      },
      { timeout: 15_000 },
    );
    const metadataPath = path.join(
      directory,
      "plugin-setup",
      state.id,
      "state.json",
    );
    // Metadata has no second copy of the SDK's conversation history.
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
        pluginId: "personal:ai-created",
      });
    });
    expect(await readFile(metadataPath, "utf8")).not.toContain("messages");
    await app.close();
    const restarted = createApp({
      dataDirectory: directory,
      piAgentDirectory: directory,
      createModelRuntime: async () => runtime,
    });
    cleanup.push(() => restarted.close());
    expect(
      (
        await restarted.inject({
          method: "GET",
          url: `/plugins/setup-sessions/${state.id}`,
        })
      ).json().messages,
    ).toEqual([
      { role: "user", text: "Create an MCP plugin" },
      {
        role: "assistant",
        text: "Created the MCP plugin. Configure it in Plugins.",
      },
    ]);
    expect(receivedToolResult).toBe(true);
    expect(
      (
        await restarted.inject({
          method: "GET",
          url: "/plugins/personal%3Aai-created",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await restarted.inject({ method: "GET", url: "/projects" })).json(),
    ).toEqual([]);
  }, 20_000);

  it("completes OAuth through UI actions and reconnects without putting tokens in plugin config", async () => {
    const previousStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    cleanup.push(async () => {
      if (previousStore === undefined)
        delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
      else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previousStore;
    });
    const { service } = await environment();
    let base = "",
      exchanged = false;
    const server = createServer(async (req, res) => {
      const send = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url?.startsWith("/.well-known/oauth-protected-resource"))
        return send({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (req.url?.startsWith("/.well-known/oauth-authorization-server"))
        return send({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/token") {
        const params = new URLSearchParams(body);
        exchanged =
          params.get("code") === "fixture-code" &&
          Boolean(params.get("code_verifier"));
        return send({
          access_token: "fixture-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (
        req.url === "/mcp" &&
        req.headers.authorization !== "Bearer fixture-access-token"
      ) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "oauth-fixture", version: "1.0.0" },
              }
            : { tools: [{ name: "account", inputSchema: { type: "object" } }] },
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const plugin = await service.create({
      name: "oauth-fixture",
      servers: {
        api: {
          url: `${base}/mcp`,
          auth: "oauth",
          oauth: {
            clientId: "fixture-client",
            redirectUri: "http://127.0.0.1:45678/callback",
          },
        },
      },
    });
    const started = await service.test(plugin, "api", "auth-start");
    expect(started.status).toBe("needs-auth");
    const url = new URL(started.authorizationUrl!);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "fixture-code");
    expect(
      await service.test(plugin, "api", "auth-complete", callback.toString()),
    ).toMatchObject({ status: "connected" });
    expect(exchanged).toBe(true);
    expect(await service.test(plugin, "api")).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(
      await readFile(service.configuration.filePath, "utf8").catch(() => ""),
    ).not.toContain("fixture-access-token");
  }, 45_000);

  it("creates persistent assistant sessions without creating game projects", async () => {
    const app = createApp({
      dataDirectory: await mkdtemp(path.join(tmpdir(), "ohmygame-setup-api-")),
    });
    cleanup.push(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/plugins/setup-sessions",
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/plugins/setup-sessions/${response.json().id}`,
        })
      ).json(),
    ).toMatchObject({ id: response.json().id, messages: [], busy: false });
    expect(
      (await app.inject({ method: "GET", url: "/projects" })).json(),
    ).toEqual([]);
  });
});
