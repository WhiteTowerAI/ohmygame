import { defineTool } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequestDetails } from "../src/shared/agent-runtimes.js";
import { ClaudeCodeDriver } from "../src/daemon/agent-runtimes/claude-code.js";
import { CodexDriver } from "../src/daemon/agent-runtimes/codex.js";
import { OpenCodeDriver } from "../src/daemon/agent-runtimes/opencode.js";
import { createServer, type ServerResponse } from "node:http";
import type { DriverContext } from "../src/daemon/agent-runtimes/driver-context.js";
import type {
  NativeToolResult,
  NativeTurnSink,
} from "../src/daemon/agent-runtimes/native-session.js";
import { setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  setAgentProcessSpawner(undefined);
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface FakeCli {
  args: string[];
  env: Record<string, string>;
  send(message: unknown): void;
  line(text: string): void;
  exit(code: number): void;
}

/** Replaces the spawner with an in-process CLI that sees what the adapter writes and answers it. */
function fakeCli(
  handle: (
    message: Record<string, unknown>,
    cli: FakeCli,
  ) => void | Promise<void>,
): FakeCli[] {
  const started: FakeCli[] = [];
  setAgentProcessSpawner(((
    _binary: string,
    args: string[],
    options: { env: Record<string, string> },
  ) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: () => true,
    });
    const cli: FakeCli = {
      args,
      env: options.env,
      send: (message) => stdout.write(`${JSON.stringify(message)}\n`),
      line: (text) => stdout.write(`${text}\n`),
      exit: (code) => {
        child.exitCode = code;
        stdout.end();
        child.emit("close", code, null);
      },
    };
    stdin.on("finish", () => {
      if (child.exitCode === null) cli.exit(0);
    });
    readline
      .createInterface({ input: stdin })
      .on(
        "line",
        (line) => void handle(JSON.parse(line) as Record<string, unknown>, cli),
      );
    started.push(cli);
    void handle({ type: "spawned" }, cli);
    return child;
  }) as never);
  return started;
}

function recordingSink(
  decide: (
    details: ApprovalRequestDetails,
  ) => "allow" | "allow-session" | "deny" = () => "deny",
) {
  const calls: string[] = [];
  const results = new Map<
    string,
    { result: NativeToolResult; isError: boolean }
  >();
  const asked: ApprovalRequestDetails[] = [];
  let sessionId: string | undefined;
  const sink: NativeTurnSink = {
    text: (key, delta) => calls.push(`text:${key}:${delta}`),
    textDone: (key, text) =>
      calls.push(`textDone:${key}${text !== undefined ? `:${text}` : ""}`),
    thinking: (key, delta) => calls.push(`thinking:${key}:${delta}`),
    thinkingDone: (key) => calls.push(`thinkingDone:${key}`),
    toolCall: (callId, name, args) =>
      calls.push(`toolCall:${callId}:${name}:${JSON.stringify(args)}`),
    toolStarted: (callId) => calls.push(`toolStarted:${callId}`),
    toolUpdate: () => {},
    toolResult: (callId, result, isError) => {
      calls.push(`toolResult:${callId}:${isError}`);
      results.set(callId, { result, isError });
    },
    usage: (usage, contextWindow, tokens) =>
      calls.push(
        `usage:${usage.input}:${usage.output}:${contextWindow ?? ""}:${tokens ?? ""}`,
      ),
    compaction: (phase) => calls.push(`compaction:${phase}`),
    nativeSession: (id) => {
      sessionId = id;
    },
    requestApproval: async (details) => {
      asked.push(details);
      return decide(details);
    },
  };
  return { sink, calls, results, asked, sessionId: () => sessionId };
}

async function context(
  overrides: Partial<DriverContext> = {},
): Promise<DriverContext> {
  const privateDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-agent-"),
  );
  cleanup.push(() => rm(privateDirectory, { recursive: true, force: true }));
  const echo = defineTool({
    name: "echo_tool",
    label: "Echo",
    description: "Echo a value",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, input) => ({
      content: [{ type: "text", text: `echo ${input.value}` }],
      details: {
        artifact: { type: "image", path: "art.png", mediaType: "image/png" },
      },
    }),
  });
  return {
    binaryPath: "/usr/local/bin/fake",
    workspacePath: "/tmp/workspace",
    env: {},
    privateDirectory,
    isolateUserConfig: true,
    instructions: "Project instructions",
    bridge: new ToolBridge([echo] as never),
    policy: { workspacePath: "/tmp/workspace", neverTouch: ["/tmp/secrets"] },
    skillDirectories: [],
    model: "sonnet",
    reasoningLevel: "high",
    ...overrides,
  };
}

describe("Claude Code adapter", () => {
  it("streams a turn, answers OhMyGame's tools over its pipe and asks before risky commands", async () => {
    const pending = new Map<
      string,
      (response: Record<string, unknown>) => void
    >();
    let next = 0;
    const ask = (cli: FakeCli, request: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = `cli-${++next}`;
        pending.set(id, resolve);
        cli.send({ type: "control_request", request_id: id, request });
      });
    const clis = fakeCli(async (message, cli) => {
      if (message.type === "control_response") {
        const response = message.response as {
          request_id: string;
          response?: Record<string, unknown>;
        };
        pending.get(response.request_id)?.(response.response ?? {});
        return;
      }
      if (message.type === "control_request") {
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
        return;
      }
      if (message.type !== "user") return;
      cli.send({
        type: "system",
        subtype: "init",
        session_id: "claude-session-1",
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start", message: { id: "m1" } },
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Checking" },
        },
      });
      cli.send({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_stop", index: 0 },
      });
      cli.send({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [
            { type: "text", text: "Checking" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__ohmygame__echo_tool",
              input: { value: "x" },
            },
            {
              type: "tool_use",
              id: "toolu_2",
              name: "Bash",
              input: { command: "git push" },
            },
            {
              type: "tool_use",
              id: "toolu_3",
              name: "ToolSearch",
              input: { query: "select:x" },
            },
          ],
        },
      });
      // OhMyGame's own tool needs no permission and runs in the daemon.
      expect(
        await ask(cli, {
          subtype: "can_use_tool",
          tool_name: "mcp__ohmygame__echo_tool",
          mcp_server: { name: "ohmygame" },
          input: { value: "x" },
          tool_use_id: "toolu_1",
        }),
      ).toMatchObject({ behavior: "allow" });
      const mcp = await ask(cli, {
        subtype: "mcp_message",
        server_name: "ohmygame",
        message: {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "echo_tool",
            arguments: { value: "x" },
            _meta: { "claudecode/toolUseId": "toolu_1" },
          },
        },
      });
      expect(mcp).toEqual({
        mcp_response: {
          jsonrpc: "2.0",
          id: 7,
          result: { content: [{ type: "text", text: "echo x" }] },
        },
      });
      cli.send({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "echo x" }],
            },
          ],
        },
      });
      expect(
        await ask(cli, {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "git push" },
          tool_use_id: "toolu_2",
        }),
      ).toMatchObject({ behavior: "deny" });
      cli.send({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: "The user did not allow this.",
              is_error: true,
            },
          ],
        },
      });
      cli.send({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m2", content: [{ type: "text", text: "Done" }] },
      });
      cli.send({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 0,
        },
        modelUsage: { sonnet: { contextWindow: 200_000 } },
      });
    });
    const driver = new ClaudeCodeDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const outcome = await driver.runTurn(
      { text: "go", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ status: "completed" });
    const args = clis[0]!.args;
    expect(args).toEqual(
      expect.arrayContaining([
        "--permission-prompt-tool",
        "stdio",
        "--model",
        "sonnet",
        "--effort",
        "high",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--append-system-prompt",
        "Project instructions",
      ]),
    );
    expect(args).toContain("--session-id");
    expect(recorded.sessionId()).toBe("claude-session-1");
    expect(recorded.calls).toEqual([
      "text:m1:0:Checking",
      "textDone:m1:0",
      'toolCall:toolu_1:echo_tool:{"value":"x"}',
      'toolCall:toolu_2:bash:{"command":"git push"}',
      "toolResult:toolu_1:false",
      "toolResult:toolu_2:true",
      "textDone:m2:0:Done",
      "usage:10:5:200000:100",
    ]);
    // The record keeps the tool's own result, with its artifact, rather than MCP's text.
    expect(recorded.results.get("toolu_1")?.result.details).toEqual({
      artifact: { type: "image", path: "art.png", mediaType: "image/png" },
    });
    expect(recorded.asked).toEqual([
      expect.objectContaining({
        kind: "command",
        tool: "Bash",
        command: "git push",
      }),
    ]);
  });

  it("resumes the session it was given and reports a CLI that exits mid-turn", async () => {
    const clis = fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user") setTimeout(() => cli.exit(1), 5);
    });
    const driver = new ClaudeCodeDriver(
      await context({ resume: "earlier-session", isolateUserConfig: false }),
    );
    cleanup.push(() => driver.dispose());
    const outcome = await driver.runTurn(
      { text: "go", images: [], readOnly: true },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Claude Code exited with code 1"),
    });
    expect(clis[0]!.args).toEqual(
      expect.arrayContaining([
        "--resume",
        "earlier-session",
        "--permission-mode",
        "plan",
      ]),
    );
    expect(clis[0]!.args).not.toContain("--strict-mcp-config");
  });
});

describe("Codex adapter", () => {
  it("runs a turn on a thread with OhMyGame's tools and asks before anything its sandbox would stop", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const pending = new Map<
      number,
      (result: Record<string, unknown>) => void
    >();
    let serverId = 100;
    const fromServer = (
      cli: FakeCli,
      method: string,
      params: Record<string, unknown>,
    ) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++serverId;
        pending.set(id, resolve);
        cli.send({ jsonrpc: "2.0", id, method, params });
      });
    const notify = (
      cli: FakeCli,
      method: string,
      params: Record<string, unknown>,
    ) => cli.send({ jsonrpc: "2.0", method, params });
    fakeCli(async (message, cli) => {
      if (message.method === undefined && typeof message.id === "number") {
        pending.get(message.id)?.(message.result as Record<string, unknown>);
        return;
      }
      const method = String(message.method);
      requests.push({
        method,
        params: (message.params ?? {}) as Record<string, unknown>,
      });
      const reply = (result: unknown) =>
        cli.send({ jsonrpc: "2.0", id: message.id, result });
      if (method === "initialized") return;
      if (method === "initialize") return reply({});
      if (method === "config/read")
        return reply({
          config: { mcp_servers: { personal: { command: "x" } } },
        });
      if (method === "thread/start")
        return reply({ thread: { id: "thread-1" } });
      if (method !== "turn/start") return reply({});
      reply({ turn: { id: "turn-1" } });
      const turn = { threadId: "thread-1", turnId: "turn-1" };
      notify(cli, "item/started", {
        ...turn,
        item: { type: "agentMessage", id: "msg-1", text: "" },
      });
      notify(cli, "item/agentMessage/delta", {
        ...turn,
        itemId: "msg-1",
        delta: "Working",
      });
      notify(cli, "item/completed", {
        ...turn,
        item: { type: "agentMessage", id: "msg-1", text: "Working" },
      });
      notify(cli, "item/started", {
        ...turn,
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: "echo_tool",
          arguments: { value: "y" },
        },
      });
      expect(
        await fromServer(cli, "item/tool/call", {
          ...turn,
          callId: "call-1",
          tool: "echo_tool",
          arguments: { value: "y" },
        }),
      ).toEqual({
        contentItems: [{ type: "inputText", text: "echo y" }],
        success: true,
      });
      notify(cli, "item/completed", {
        ...turn,
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: "echo_tool",
          contentItems: [{ type: "inputText", text: "echo y" }],
          success: true,
        },
      });
      notify(cli, "item/started", {
        ...turn,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "/bin/zsh -lc 'touch /tmp/workspace/a'",
        },
      });
      // Inside the workspace, but Codex only asks when its sandbox would stop the command, so the person decides.
      expect(
        await fromServer(cli, "item/commandExecution/requestApproval", {
          ...turn,
          itemId: "cmd-1",
          command: "/bin/zsh -lc 'touch /tmp/workspace/a'",
          startedAtMs: 1,
        }),
      ).toEqual({ decision: "decline" });
      notify(cli, "item/completed", {
        ...turn,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "touch",
          status: "declined",
          aggregatedOutput: "",
        },
      });
      notify(cli, "thread/tokenUsage/updated", {
        ...turn,
        tokenUsage: {
          total: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 5 },
          last: { inputTokens: 40, outputTokens: 5 },
          modelContextWindow: 400_000,
        },
      });
      notify(cli, "turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
    });
    const driver = new CodexDriver(await context({ model: "gpt-5.6-sol" }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const outcome = await driver.runTurn(
      {
        text: "go",
        images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
        readOnly: false,
      },
      recorded.sink,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ status: "completed" });
    const thread = requests.find(
      (request) => request.method === "thread/start",
    )!.params;
    expect(thread).toMatchObject({
      cwd: "/tmp/workspace",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      developerInstructions: "Project instructions",
      config: { "mcp_servers.personal.enabled": false, notify: [] },
    });
    expect(thread.dynamicTools).toEqual([
      expect.objectContaining({ type: "function", name: "echo_tool" }),
    ]);
    const turn = requests.find(
      (request) => request.method === "turn/start",
    )!.params;
    expect(turn).toMatchObject({
      threadId: "thread-1",
      effort: "high",
      input: [
        { type: "text", text: "go" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(recorded.sessionId()).toBe("thread-1");
    expect(recorded.calls).toEqual([
      "text:msg-1:Working",
      "textDone:msg-1:Working",
      'toolCall:call-1:echo_tool:{"value":"y"}',
      "toolStarted:call-1",
      "toolResult:call-1:false",
      'toolCall:cmd-1:bash:{"command":"touch /tmp/workspace/a"}',
      "toolStarted:cmd-1",
      "toolResult:cmd-1:true",
      "usage:40:5:400000:45",
    ]);
    expect(recorded.results.get("call-1")?.result.details).toEqual({
      artifact: { type: "image", path: "art.png", mediaType: "image/png" },
    });
    expect(recorded.asked).toEqual([
      expect.objectContaining({
        kind: "command",
        command: "touch /tmp/workspace/a",
      }),
    ]);
  });
});

describe("OpenCode adapter", () => {
  it("drives a session on its own server and answers its permission requests", async () => {
    const replies: Array<{ id: string; body: unknown }> = [];
    const prompts: unknown[] = [];
    let events: ServerResponse | undefined;
    const emit = (type: string, properties: Record<string, unknown>) =>
      events?.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      expect(request.headers.authorization).toMatch(/^Basic /);
      if (request.url === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        events = response;
        return;
      }
      if (request.method === "POST" && request.url === "/session")
        return response.end(JSON.stringify({ id: "ses_1" }));
      const permission = request.url?.match(/^\/permission\/(.+)\/reply$/);
      if (permission) {
        replies.push({ id: permission[1]!, body });
        response.end("true");
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_tool",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: {
              status: "error",
              input: { command: "sudo ls" },
              error: "rejected",
            },
          },
        });
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_text",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "text",
            text: "Could not",
            time: { start: 1, end: 2 },
          },
        });
        emit("message.updated", {
          sessionID: "ses_1",
          info: {
            id: "msg_a",
            role: "assistant",
            tokens: { input: 30, output: 4, cache: { read: 10, write: 0 } },
          },
        });
        emit("session.idle", { sessionID: "ses_1" });
        return;
      }
      if (request.url === "/session/ses_1/prompt_async") {
        prompts.push(body);
        response.writeHead(204).end();
        emit("session.status", {
          sessionID: "ses_1",
          status: { type: "busy" },
        });
        emit("message.updated", {
          sessionID: "ses_1",
          info: { id: "msg_u", role: "user" },
        });
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_u",
            messageID: "msg_u",
            sessionID: "ses_1",
            type: "text",
            text: "go",
          },
        });
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_r",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "reasoning",
            text: "",
            time: { start: 1 },
          },
        });
        emit("message.part.delta", {
          sessionID: "ses_1",
          messageID: "msg_a",
          partID: "prt_r",
          field: "text",
          delta: "Thinking",
        });
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_r",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "reasoning",
            text: "Thinking",
            time: { start: 1, end: 2 },
          },
        });
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_tool",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { status: "pending", input: {} },
          },
        });
        emit("message.part.updated", {
          sessionID: "ses_1",
          part: {
            id: "prt_tool",
            messageID: "msg_a",
            sessionID: "ses_1",
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { status: "running", input: { command: "sudo ls" } },
          },
        });
        emit("permission.asked", {
          id: "per_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["sudo ls"],
          metadata: { command: "sudo ls" },
          always: ["sudo *"],
          tool: { messageID: "msg_a", callID: "call_1" },
        });
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise((resolve) => {
          events?.end();
          server.close(() => resolve(undefined));
          server.closeAllConnections();
        }),
    );
    const port = (server.address() as { port: number }).port;
    const clis = fakeCli((message, cli) => {
      if (message.type === "spawned")
        setTimeout(
          () =>
            cli.line(`opencode server listening on http://127.0.0.1:${port}`),
          5,
        );
    });
    const driver = new OpenCodeDriver(
      await context({
        model: "anthropic/claude-sonnet-5",
        reasoningLevel: "high",
      }),
    );
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const outcome = await driver.runTurn(
      { text: "go", images: [], readOnly: true },
      recorded.sink,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ status: "completed" });
    expect(prompts).toEqual([
      expect.objectContaining({
        model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
        variant: "high",
        agent: "plan",
        system: "Project instructions",
        parts: [{ type: "text", text: "go" }],
      }),
    ]);
    expect(replies).toEqual([{ id: "per_1", body: { reply: "reject" } }]);
    expect(recorded.asked).toEqual([
      expect.objectContaining({ kind: "command", command: "sudo ls" }),
    ]);
    expect(recorded.sessionId()).toBe("ses_1");
    expect(recorded.calls).toEqual([
      "thinking:prt_r:Thinking",
      "thinkingDone:prt_r",
      'toolCall:call_1:bash:{"command":"sudo ls"}',
      "toolStarted:call_1",
      "toolResult:call_1:true",
      "text:prt_text:Could not",
      "textDone:prt_text:Could not",
      "usage:30:4::40",
    ]);
    const config = JSON.parse(clis[0]!.env.OPENCODE_CONFIG_CONTENT!) as {
      permission: { external_directory: string };
      share: string;
    };
    expect(config).toMatchObject({
      share: "disabled",
      permission: { external_directory: "ask" },
    });
    expect(clis[0]!.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_SERVER_PASSWORD: expect.any(String),
    });
    expect(clis[0]!.args).toEqual([
      "serve",
      "--pure",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ]);
  });
});
