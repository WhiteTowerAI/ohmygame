import { createJiti } from "jiti";
import { createRequire } from "node:module";
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
import { PluginMcpHost } from "../src/daemon/plugin-mcp-host.js";
import { createApp } from "../src/daemon/app.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-mcp-host-"));
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  const host = new PluginMcpHost();
  cleanup.push(() => host.close());
  return { directory, agentDir, host };
}
describe("plugin MCP host", () => {
  it("gates every nested script call and reports only actual RPC outcomes", async () => {
    const { host, directory } = await environment();
    const callsFile = path.join(directory, "calls.jsonl");
    const before = vi.fn(async (call: { args: Record<string, unknown> }) => {
      if (call.args.value === "denied") throw new Error("acme/guard: desktop control denied");
    });
    const after = vi.fn(async () => {});
    const toolNames = new Set<string>();
    const config = { mcpServers: { local: { command: process.execPath, args: [path.resolve("test/fixtures/plugin-mcp-server.mjs"), path.join(directory, "pid"), callsFile] } } };
    const settingsManager = SettingsManager.inMemory({ packages: [] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
      extensionFactories: [{ name: "plugin-mcp", factory: await host.extension(config, { toolHooks: { before, after }, toolNames }) }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader, noTools: "builtin", sessionManager: SessionManager.inMemory(directory) });
    const close = host.manage(session);
    try {
      await session.bindExtensions({ mode: "rpc" });
      const script = session.getToolDefinition("mcpScript")!;
      expect(toolNames).toContain("mcpScript");
      const result = await script.execute("batch", { code: 'for (const value of ["first", "denied", "third"]) emit(await tools.local_echo({ value }));' }, undefined, undefined, session.extensionRunner.createToolContext("batch", undefined));
      expect(JSON.stringify(result)).toContain("desktop control denied");
      expect(before).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2));
      expect((await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line).value)).toEqual(["first", "third"]);
      expect(after.mock.calls).toMatchObject([[{ source: "mcp", server: "local", tool: "echo", status: "succeeded", text: "first" }], [{ text: "third" }]]);
      expect((after.mock.calls[0] as unknown as [{ callId: string }])[0].callId).toBe((before.mock.calls[0]![0] as { callId?: string }).callId);
    } finally { await close(); }
  });

  it("uses the same live gate for native agents and refuses a changed server after approval", async () => {
    const { host, directory } = await environment();
    let disabled = false;
    const after = vi.fn(async () => {});
    const native = await host.tool({ mcpServers: { local: { command: process.execPath, args: [path.resolve("test/fixtures/plugin-mcp-server.mjs")] } } }, directory,
      async () => disabled ? "server changed" : undefined,
      { before: async () => { disabled = true; }, after });
    try {
      const result = await native.tool.execute("one", { server: "local", tool: "local_echo", args: { value: "must not run" } }, undefined, undefined, undefined as never);
      expect(JSON.stringify(result)).toContain("server changed");
      expect(after).not.toHaveBeenCalled();
    } finally { await native.close(); }
  });

  it("connects to a real STDIO server, lists tools and shuts the process down", async () => {
    const { host, directory, agentDir } = await environment();
    const pidFile = path.join(directory, "server.pid");
    const result = await host.probe("local", "local", {
      command: process.execPath,
      args: [path.resolve("test/fixtures/plugin-mcp-server.mjs"), pidFile],
    }, agentDir, "test");
    expect(result).toMatchObject({ status: "connected", toolCount: 1 });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 45_000);
  it("keeps an HTTP server restricted to its origins there: no redirects, probes or interpreted headers", async () => {
    const { host, agentDir } = await environment();
    const listen = async (handler: Parameters<typeof createServer>[1]) => {
      const server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    };
    let elsewhere = 0;
    const other = await listen((_req, res) => {
      elsewhere++;
      res.writeHead(404);
      res.end();
    });
    const redirecting = await listen((_req, res) => {
      res.writeHead(307, { location: `${other}/mcp` });
      res.end();
    });
    const headers: Record<string, string | undefined> = {};
    const working = await listen(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      headers.secret = req.headers["x-secret"] as string | undefined;
      headers.home = req.headers["x-home"] as string | undefined;
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "restricted", version: "1.0.0" } }
        : { tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    const probe = (key: string, definition: Record<string, unknown>) => host.probe(key, key, definition, agentDir, "test");

    // Headers are sent as written: no command runs, no variable expands.
    expect(await probe("working", {
      url: `${working}/mcp`,
      allowedOrigins: [working],
      headers: { "X-Secret": "!echo leaked", "X-Home": "${HOME}" },
    })).toMatchObject({ status: "connected", toolCount: 1 });
    expect(headers).toEqual({ secret: "!echo leaked", home: "${HOME}" });

    // A redirect elsewhere is refused, and the failure isn't probed past it.
    expect(await probe("redirecting", { url: `${redirecting}/mcp`, allowedOrigins: [redirecting] })).toMatchObject({ status: "failed" });
    expect(elsewhere).toBe(0);

    // A URL outside its origins, or a restriction that can't be read, reaches nothing.
    expect(await probe("outside", { url: `${other}/mcp`, allowedOrigins: [working] })).toMatchObject({ status: "failed" });
    expect(await probe("empty", { url: `${other}/mcp`, allowedOrigins: [] })).toMatchObject({ status: "failed" });
    expect(elsewhere).toBe(0);
  }, 45_000);
  it("executes real MCP tools through a plugin session", async () => {
    const { host, directory } = await environment();
    const shared = "local";
    const config = { mcpServers: { [shared]: { command: process.execPath, args: [path.resolve("test/fixtures/plugin-mcp-server.mjs")] } } };
    const settingsManager = SettingsManager.inMemory({ packages: [] });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [
        { name: "plugin-mcp", factory: await host.extension(config) },
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
    const close = host.manage(session);
    try {
      await session.bindExtensions({ mode: "rpc" });
      const mcp = session.getToolDefinition("mcp")!;
      const result = await mcp.execute(
        "echo-call",
        {
          server: shared,
          tool: `${shared}_echo`,
          args: { value: "actual tool result" },
        },
        undefined,
        undefined,
        session.extensionRunner.createToolContext("echo-call", undefined),
      );
      expect(JSON.stringify(result)).toContain("actual tool result");
      expect(host.status(shared)).toMatchObject({
        status: "connected",
        toolCount: 1,
      });
    } finally {
      // Disposing waits for the servers to shut down, as `close` does.
      await (session.dispose() as unknown as Promise<void>);
    }
    expect(host.status(shared)).toBeUndefined();
    await close();
  });

  it("stops a session's MCP calls once its plugins change", async () => {
    const { host, directory } = await environment();
    const config = { mcpServers: { local: { command: process.execPath, args: [path.resolve("test/fixtures/plugin-mcp-server.mjs")] } } };
    let reason: string | undefined;
    const guard = async () => reason;
    // A coding agent calls the mcp tool directly.
    const native = await host.tool(config, directory, guard);
    try {
      const call = () => native.tool.execute("echo-call", { server: "local", tool: "local_echo", args: { value: "still on" } }, undefined, undefined, undefined as never);
      expect(JSON.stringify(await call())).toContain("still on");
      reason = "plugins changed";
      await expect(call()).rejects.toThrow("plugins changed");
    } finally {
      await native.close();
    }
    // Pi asks the session's tool_call hook first, for the adapter's tools only.
    reason = undefined;
    const settingsManager = SettingsManager.inMemory({ packages: [] });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [{ name: "plugin-mcp", factory: await host.extension(config, { guard }) }],
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
    const close = host.manage(session);
    try {
      await session.bindExtensions({ mode: "rpc" });
      const event = { type: "tool_call", toolCallId: "echo-call", toolName: "mcp", input: {} } as never;
      // Calls made inside a tool call, as a script's are, skip that hook; the adapter's approval asks instead.
      const mcp = session.getToolDefinition("mcp")!;
      const nested = async () => JSON.stringify(await mcp.execute("echo-call", { server: "local", tool: "local_echo", args: { value: "nested" } },
        undefined, undefined, session.extensionRunner.createToolContext("echo-call", undefined)));
      expect(await session.extensionRunner.emitToolCall(event)).toBeUndefined();
      expect(await nested()).toContain("nested");
      reason = "plugins changed";
      expect(await session.extensionRunner.emitToolCall(event)).toEqual({ block: true, reason: "plugins changed" });
      expect(await session.extensionRunner.emitToolCall({ ...(event as object), toolName: "read" } as never)).toBeUndefined();
      expect(await nested()).toContain("approval_denied");
    } finally {
      await close();
    }
  });

  it("runs a plugin workspace's agent in its hidden project, through a model tool call", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-setup-model-"),
    );
    const calls = [
      { action: "prepare", input: { path: "ai-created" } },
      { action: "read" },
      { action: "test", server: "api" },
      { action: "read", id: "ohmygame/blender" },
    ];
    let requests = 0;
    const toolResults = new Map<string, string>();
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      for (const message of payload.messages)
        if (message.role === "tool") toolResults.set(message.tool_call_id, message.content);
      // The project names itself from the first message, with no tools to call.
      const index = payload.tools?.length ? requests++ : calls.length;
      const delta = index < calls.length
        ? { role: "assistant", tool_calls: [{ index: 0, id: `plugin-tool-${index}`, type: "function",
          function: { name: "plugin_manage", arguments: JSON.stringify(calls[index]) },
        }] }
        : { role: "assistant", content: "Prepared the MCP plugin draft. Review it in the builder." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: index < calls.length ? "tool_calls" : "stop" }] })}\n\n`,
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
    // What the assistant would have written with its file tools.
    const draftRoot = path.join(directory, "plugin-setup", state.id, "workspace", "ai-created");
    await mkdir(path.join(draftRoot, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(draftRoot, ".ohmygame-plugin/plugin.json"), JSON.stringify({
      id: "personal/ai-created", version: "0.1.0", engines: { "ohmygame-api": "^2.0.0" },
      displayName: "AI Created", description: "Made by the assistant",
      capabilities: { processes: ["node"] },
      contributes: { mcpServers: [{ id: "api", title: "API", command: "node", args: ["./server.mjs"], tools: ["echo"] }] },
    }));
    await writeFile(path.join(draftRoot, "server.mjs"), await readFile(path.resolve("test/fixtures/plugin-mcp-server.mjs")));
    // The workspace's conversations are its project's, run as any project's are.
    const conversations = `/projects/${state.projectId}/conversations`;
    const conversation = (await app.inject({ method: "POST", url: conversations, payload: { model: { provider: created.json().id, id: "fixture" } } })).json();
    const prompt = await app.inject({ method: "POST", url: `${conversations}/${conversation.id}/turns`, payload: { prompt: "Create an MCP plugin" } });
    expect(prompt.statusCode, prompt.body).toBe(202);
    const items = async (on = app) => ((await on.inject({ method: "GET", url: `${conversations}/${conversation.id}` })).json().turns as Array<{ items: unknown[] }>)
      .flatMap(turn => turn.items);
    await vi.waitFor(
      async () => {
        expect(await items()).toContainEqual(expect.objectContaining({
          type: "agentMessage", text: "Prepared the MCP plugin draft. Review it in the builder.",
        }));
        expect(await items()).toContainEqual(expect.objectContaining({ type: "dynamicToolCall", tool: "plugin_manage", status: "completed" }));
        const current = (await app.inject({ method: "GET", url: `/plugins/setup-sessions/${state.id}` })).json();
        expect(current).toMatchObject({ status: "ready" });
        expect(current.pluginId).toBeUndefined();
      },
      { timeout: 15_000 },
    );
    const draft = (await app.inject({ method: "GET", url: `/plugins/setup-sessions/${state.id}/draft` })).json();
    expect(draft).toMatchObject({ plugin: { id: "personal/ai-created", appWide: false }, errors: [] });
    expect(JSON.parse(toolResults.get("plugin-tool-1")!)).toMatchObject({ plugin: { id: "personal/ai-created" } });
    expect(JSON.parse(toolResults.get("plugin-tool-2")!)).toMatchObject({ status: "connected", toolCount: 1 });
    expect(toolResults.get("plugin-tool-3")).toContain("omit id");
    expect(draft.plugin.mcpServers).toMatchObject([{ id: "api" }]);
    expect(draft.checks.api).toMatchObject({ revision: draft.revision, result: { status: "connected", toolCount: 1 } });
    const installed = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: draft.revision } });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ pluginId: "personal/ai-created", status: "installed" });
    const metadataPath = path.join(
      directory,
      "plugin-setup",
      state.id,
      "state.json",
    );
    // Metadata has no second copy of the SDK's conversation history.
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
        pluginId: "personal/ai-created",
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
    expect(await items(restarted)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "userMessage", text: "Create an MCP plugin" }),
      expect.objectContaining({ type: "agentMessage", text: "Prepared the MCP plugin draft. Review it in the builder." }),
    ]));
    expect(toolResults.size).toBe(calls.length);
    expect((await restarted.inject({ method: "GET", url: "/plugin-store/plugins" })).json()).toContainEqual(
      expect.objectContaining({ id: "personal/ai-created" }),
    );
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
    const { host, agentDir, directory } = await environment();
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
    const definition = {
      url: `${base}/mcp`,
      auth: "oauth",
      oauth: { clientId: "fixture-client", redirectUri: "http://127.0.0.1:45678/callback" },
    };
    const started = await host.probe("oauth", "oauth", definition, agentDir, "auth-start");
    expect(started.status).toBe("needs-auth");
    const url = new URL(started.authorizationUrl!);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "fixture-code");
    expect(
      await host.probe("oauth", "oauth", definition, agentDir, "auth-complete", callback.toString()),
    ).toMatchObject({ status: "connected" });
    expect(exchanged).toBe(true);
    expect(await host.probe("oauth", "oauth", definition, agentDir, "test")).toMatchObject({
      status: "connected",
      toolCount: 1,
    });
    expect(
      await readFile(path.join(directory, "plugin-configuration.json"), "utf8").catch(() => ""),
    ).not.toContain("fixture-access-token");
  }, 45_000);

  it("keeps a workspace's project out of the list of projects", async () => {
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
    ).toMatchObject({ id: response.json().id, projectId: expect.any(String), status: "idle" });
    expect(
      (await app.inject({ method: "GET", url: "/projects" })).json(),
    ).toEqual([]);
  });
});

it("keeps the host's live gate ahead of the adapter's cached session approval", async () => {
  const file = path.join(path.dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter")), "tool-approval.ts");
  const adapter = await createJiti(import.meta.url).import(file) as { ensureToolCallApproved: (...args: unknown[]) => Promise<unknown> };
  let deny = false;
  const calls: string[] = [];
  const state = { config: { mcpServers: { local: {} } }, approvedToolCalls: new Map(), approvalEvents: {
    emit: (_event: string, request: { requestId: string; claim: (handler: () => string) => void }) => {
      calls.push(request.requestId);
      request.claim(() => { if (deny) throw new Error("acme/guard: disabled now"); return "allow_for_session"; });
    },
  } };
  const metadata = { name: "local_echo", originalName: "echo", description: "Echo" };
  expect(await adapter.ensureToolCallApproved(state, "local", metadata, { value: "same" })).toMatchObject({ ok: true });
  expect(state.approvedToolCalls.size).toBe(1);
  deny = true;
  expect(await adapter.ensureToolCallApproved(state, "local", metadata, { value: "same" })).toMatchObject({ ok: false, message: "acme/guard: disabled now" });
  expect(new Set(calls).size).toBe(2);
});
