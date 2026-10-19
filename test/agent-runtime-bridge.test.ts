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

async function fixture(nestedWorkspace = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-bridge-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "opencode");
  await writeFile(
    executable,
    `#!${process.execPath}\nconsole.log('1.18.33');\n`,
    { mode: 0o700 },
  );
  let events: ServerResponse | undefined;
  const tokens: string[] = [];
  const asked: ApprovalRequestDetails[] = [];
  const replies: unknown[] = [];
  let prompts = 0;
  let running = false;
  const emit = (type: string, properties: Record<string, unknown> = {}) =>
    events?.write(
      `data: ${JSON.stringify({ type, properties: { sessionID: "session-1", ...properties } })}\n\n`,
    );
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    if (request.url === "/event") {
      events = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/path")
      return response.end(JSON.stringify({ worktree: root }));
    if (request.url === "/session/child-1")
      return response.end(
        JSON.stringify({ id: "child-1", parentID: "session-1" }),
      );
    if (request.url === "/session/unrelated")
      return response.end(JSON.stringify({ id: "unrelated" }));
    if (request.url?.startsWith("/permission/")) {
      replies.push(body);
      response.end("{}");
      return;
    }
    if (request.url === "/mcp") {
      tokens.push(body.config.headers.Authorization);
      response.end(JSON.stringify({ ohmygame: { status: "connected" } }));
      return;
    }
    if (request.url?.endsWith("/prompt_async")) {
      prompts++;
      response.end("{}");
      emit("session.status", { status: { type: "busy" } });
      return;
    }
    if (request.url?.endsWith("/abort")) {
      response.end("{}");
      emit("session.idle");
      return;
    }
    response.end(JSON.stringify({ id: "session-1" }));
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
      stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`),
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
    policy: { workspacePath: workspace, neverTouch: [] },
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
  };
}

it("resolves native read patterns from the Git root rather than a nested app workspace", async () => {
  const f = await fixture(true);
  const run = f.session.prompt("read sibling");
  await expect.poll(f.prompts).toBe(1);
  f.emit("permission.asked", {
    id: "read-1",
    permission: "read",
    patterns: ["outside.txt"],
    metadata: {},
    always: ["*"],
  });
  await expect.poll(() => f.replies.length).toBe(1);
  expect(f.asked).toEqual([
    expect.objectContaining({ path: path.join(f.root, "outside.txt") }),
  ]);
  expect(f.replies).toEqual([{ reply: "reject" }]);
  f.emit("session.idle");
  await run;
});

it("mediates child-session approvals without admitting unrelated native sessions", async () => {
  const f = await fixture(true);
  const run = f.session.prompt("task reading reference");
  await expect.poll(f.prompts).toBe(1);
  f.emit("permission.asked", {
    sessionID: "child-1",
    id: "child-read",
    permission: "read",
    patterns: ["reference.txt"],
    metadata: {},
  });
  await expect.poll(() => f.replies.length).toBe(1);
  expect(f.asked).toEqual([
    expect.objectContaining({ path: path.join(f.root, "reference.txt") }),
  ]);
  f.emit("permission.asked", {
    sessionID: "unrelated",
    id: "foreign-read",
    permission: "read",
    patterns: ["reference.txt"],
    metadata: {},
  });
  await expect.poll(() => f.replies.length).toBe(2);
  expect(f.asked).toHaveLength(1);
  expect(f.replies).toEqual([{ reply: "reject" }, { reply: "reject" }]);
  f.emit("session.idle");
  await run;
});

it("rotates bridge capabilities each turn and permanently rejects a previous turn's token", async () => {
  const f = await fixture();
  const first = f.session.prompt("first");
  await expect.poll(f.prompts).toBe(1);
  const oldToken = f.tokens[0]!;
  expect((await f.call(oldToken)).status).toBe(200);
  f.emit("session.idle");
  await first;
  expect((await f.call(oldToken)).status).toBe(401);
  const second = f.session.prompt("second");
  await expect.poll(f.prompts).toBe(2);
  expect(f.tokens[1]).not.toBe(oldToken);
  expect((await f.call(oldToken)).status).toBe(401);
  expect((await f.call(f.tokens[1]!)).status).toBe(200);
  f.emit("session.idle");
  await second;
  expect((await f.call(f.tokens[1]!)).status).toBe(401);
});

it("aborts running bridge tools and revokes their capability when a native turn is cancelled", async () => {
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
});

it("settles a turn and stops the native process if its event stream disconnects", async () => {
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
});
