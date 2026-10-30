import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";
import type { NativeCodingSession } from "../src/daemon/agent-runtimes/native-session.js";
import type { ApprovalRequestDetails } from "../src/shared/agent-runtimes.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  setAgentProcessSpawner(undefined);
});

async function fixture(nestedWorkspace = false, holdConnection = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-bridge-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "opencode");
  await writeFile(
    executable,
    `#!${process.execPath}
console.log("opencode v2.1.0");
`,
    { mode: 0o700 },
  );
  let events: ServerResponse | undefined;
  const tokens: string[] = [];
  const asked: ApprovalRequestDetails[] = [];
  const replies: unknown[] = [];
  let prompts = 0;
  let running = false;
  let pendingConnection: ServerResponse | undefined;
  const emit = (type: string, properties: Record<string, unknown> = {}) =>
    events?.write(
      `data: ${JSON.stringify({ type, data: { sessionID: "session-1", ...properties } })}\n\n`,
    );
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const route = new URL(request.url!, "http://localhost").pathname;
    if (route === "/api/event") {
      events = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (route === "/api/info")
      return response.end(JSON.stringify({ version: "2.1.0" }));
    if (route === "/api/location")
      return response.end(
        JSON.stringify({
          directory: root,
          project: { id: "project", directory: root },
        }),
      );
    if (route === "/api/agent")
      return response.end(
        JSON.stringify({
          data: ["build", "plan"].map((id) => ({ id })),
        }),
      );
    if (route === "/api/model")
      return response.end(
        JSON.stringify({
          data: [
            {
              providerID: "test",
              id: "model",
              enabled: true,
              capabilities: { tools: true },
            },
          ],
        }),
      );
    if (route === "/api/session/child-1")
      return response.end(
        JSON.stringify({
          id: "child-1",
          parentID: "session-1",
          location: { directory: workspace },
        }),
      );
    if (route === "/api/session/moved-child")
      return response.end(
        JSON.stringify({
          id: "moved-child",
          parentID: "session-1",
          location: { directory: path.join(root, "another-workspace") },
        }),
      );
    if (route === "/api/session/unrelated")
      return response.end(JSON.stringify({ id: "unrelated" }));
    if (route.includes("/permission/")) {
      replies.push(body);
      response.end("{}");
      return;
    }
    if (route === "/api/experimental/mcp/ohmygame") {
      expect(body.config.codemode).toBe(false);
      tokens.push(body.config.headers.Authorization);
      response.end(JSON.stringify({ ohmygame: { status: "connected" } }));
      return;
    }
    if (route === "/api/experimental/mcp/ohmygame/connect") {
      if (holdConnection) {
        pendingConnection = response;
        return;
      }
      return response.writeHead(204).end();
    }
    if (route === "/api/mcp")
      return response.end(
        JSON.stringify({
          data: [{ name: "ohmygame", status: { status: "connected" } }],
        }),
      );
    if (route?.endsWith("/prompt")) {
      prompts++;
      response.end("{}");
      emit("session.execution.started");
      return;
    }
    if (route?.endsWith("/interrupt")) {
      response.end("{}");
      emit("session.execution.succeeded");
      return;
    }
    response.end(
      JSON.stringify({
        data: {
          id: "session-1",
          location: { directory: workspace },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    events?.end();
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  setAgentProcessSpawner((() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr: new PassThrough(),
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
    });
    running = true;
    stdin.on("finish", () => {
      if (!running) return;
      running = false;
      child.exitCode = 0;
      stdout.end();
      child.emit("close", 0, null);
    });
    queueMicrotask(() =>
      stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`),
    );
    return child;
  }) as never);
  const service = new AgentRuntimeService(
    path.join(root, "data"),
    () => "http://127.0.0.1:12345",
  );
  await service.load();
  await service.settings.update("opencode-cli", {
    enabled: true,
    binaryPath: executable,
  });
  cleanup.push(() => service.close());
  let toolSignal: AbortSignal | undefined;
  const echo = defineTool({
    name: "echo_tool",
    label: "Echo",
    description: "Fixture",
    parameters: Type.Object({ wait: Type.Optional(Type.Boolean()) }),
    execute: async (_id, input, signal) => {
      if (!signal)
        throw new Error("The bridge must supply a cancellation signal");
      toolSignal = signal;
      if (input.wait)
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      return {
        content: [{ type: "text", text: "ok" }],
        details: { path: "artifact.png" },
      };
    },
  });
  const workspace = nestedWorkspace ? path.join(root, "workspace") : root;
  const session: NativeCodingSession = await service.createSession({
    runtime: "opencode-cli",
    model: "test/model",
    workspacePath: workspace,
    sessionManager: SessionManager.inMemory(workspace),
    tools: [echo],
    skillDirectories: [],
    instructions: "Fixture",
    requestApproval: async (details) => {
      asked.push(details);
      return "deny";
    },
  });
  cleanup.push(() => session.dispose());
  const call = (token: string, wait = false) =>
    service.handleBridgeRequest(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo_tool", arguments: { wait } },
    });
  return {
    service,
    session,
    tokens,
    emit,
    call,
    root,
    asked,
    replies,
    prompts: () => prompts,
    signal: () => toolSignal,
    closeEvents: () => events?.end(),
    running: () => running,
    connect: () => pendingConnection?.writeHead(204).end(),
  };
}

// These cases execute POSIX script fixtures; Windows cannot start them as native CLIs.
it.skipIf(process.platform === "win32")(
  "resolves native read patterns relative to the v2 session location inside a Git worktree",
  async () => {
    const f = await fixture(true);
    const run = f.session.prompt("read sibling");
    await expect.poll(f.prompts).toBe(1);
    f.emit("permission.asked", {
      id: "read-1",
      action: "read",
      resources: ["../outside.txt"],
      metadata: {},
      save: ["*"],
    });
    await expect.poll(() => f.replies.length).toBe(1);
    expect(f.asked).toEqual([
      expect.objectContaining({ path: path.join(f.root, "outside.txt") }),
    ]);
    expect(f.replies).toEqual([
      {
        decision: "reject",
        message: expect.stringContaining("The person denied"),
      },
    ]);
    f.emit("session.execution.succeeded");
    await run;
  },
);

it.skipIf(process.platform === "win32")(
  "mediates child-session approvals without admitting unrelated native sessions",
  async () => {
    const f = await fixture(true);
    const run = f.session.prompt("task reading reference");
    await expect.poll(f.prompts).toBe(1);
    f.emit("permission.asked", {
      sessionID: "child-1",
      id: "child-read",
      action: "read",
      resources: ["../reference.txt"],
      metadata: {},
    });
    await expect.poll(() => f.replies.length).toBe(1);
    expect(f.asked).toEqual([
      expect.objectContaining({ path: path.join(f.root, "reference.txt") }),
    ]);
    f.emit("permission.asked", {
      sessionID: "unrelated",
      id: "foreign-read",
      action: "read",
      resources: ["../reference.txt"],
      metadata: {},
    });
    await expect.poll(() => f.replies.length).toBe(2);
    f.emit("permission.asked", {
      sessionID: "moved-child",
      id: "moved-read",
      action: "read",
      resources: ["reference.txt"],
    });
    await expect.poll(() => f.replies.length).toBe(3);
    expect(f.asked).toHaveLength(1);
    expect(f.replies).toEqual([
      {
        decision: "reject",
        message: expect.stringContaining("The person denied"),
      },
      { decision: "reject" },
      { decision: "reject" },
    ]);
    f.emit("session.execution.succeeded");
    await run;
  },
);

it.skipIf(process.platform === "win32")(
  "rotates bridge capabilities each turn and permanently rejects a previous turn's token",
  async () => {
    const f = await fixture();
    const first = f.session.prompt("first");
    await expect.poll(f.prompts).toBe(1);
    const oldToken = f.tokens[0]!;
    expect((await f.call(oldToken)).status).toBe(200);
    f.emit("session.execution.succeeded");
    await first;
    expect((await f.call(oldToken)).status).toBe(401);
    const second = f.session.prompt("second");
    await expect.poll(f.prompts).toBe(2);
    expect(f.tokens[1]).not.toBe(oldToken);
    expect((await f.call(oldToken)).status).toBe(401);
    expect((await f.call(f.tokens[1]!)).status).toBe(200);
    f.emit("session.execution.succeeded");
    await second;
    expect((await f.call(f.tokens[1]!)).status).toBe(401);
  },
);

it.skipIf(process.platform === "win32")(
  "aborts running bridge tools and revokes their capability when a native turn is cancelled",
  async () => {
    const f = await fixture();
    const run = f.session.prompt("wait for tool");
    await expect.poll(f.prompts).toBe(1);
    const token = f.tokens[0]!;
    const tool = f.call(token, true);
    await expect.poll(f.signal).toBeDefined();
    await f.session.abort();
    await run;
    expect(f.signal()!.aborted).toBe(true);
    expect((await tool).body).toMatchObject({ result: { isError: true } });
    expect((await f.call(token)).status).toBe(401);
    expect(f.running()).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "settles a turn and stops the native process if its event stream disconnects",
  async () => {
    const f = await fixture();
    const run = f.session.prompt("event stream disconnect");
    await expect.poll(f.prompts).toBe(1);
    f.closeEvents();
    await run;
    expect(f.running()).toBe(false);
    expect(f.session.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        stopReason: "error",
        errorMessage: "OpenCode event stream disconnected",
      }),
    );
    expect((await f.call(f.tokens[0]!)).status).toBe(401);
  },
);

it.skipIf(process.platform === "win32")(
  "waits for the native MCP connection before the model receives its tool catalog",
  async () => {
    const f = await fixture(false, true);
    const run = f.session.prompt("tools");
    await expect.poll(() => f.tokens.length).toBe(1);
    expect(f.prompts()).toBe(0);
    await expect.poll(() => Boolean(f.connect())).toBe(true);
    await expect.poll(f.prompts).toBe(1);
    f.emit("session.execution.succeeded");
    await run;
  },
);

it.skipIf(process.platform === "win32")(
  "preserves app tool names and structured results without asking for a second approval",
  async () => {
    const f = await fixture();
    const run = f.session.prompt("tool result");
    await expect.poll(f.prompts).toBe(1);
    f.emit("session.tool.input.started", {
      id: "native-tool",
      name: "ohmygame_echo_tool",
      assistantMessageID: "assistant",
    });
    f.emit("session.tool.called", {
      id: "native-tool",
      input: { wait: false },
      executed: true,
    });
    f.emit("permission.asked", {
      id: "tool-permission",
      action: "ohmygame_echo_tool",
      resources: ["*"],
      source: { type: "tool", id: "native-tool", messageID: "assistant" },
    });
    await expect.poll(() => f.replies.length).toBe(1);
    expect(f.replies).toEqual([{ decision: "once" }]);
    expect(f.asked).toEqual([]);
    await f.call(f.tokens[0]!);
    f.emit("session.tool.success", {
      id: "native-tool",
      content: [{ type: "text", text: "native text" }],
      executed: true,
    });
    f.emit("session.execution.succeeded");
    await run;
    expect(f.session.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "echo_tool",
        details: { path: "artifact.png" },
      }),
    );
  },
);
