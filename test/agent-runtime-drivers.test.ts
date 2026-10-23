import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  canonicalPath,
  neverTouchPaths,
} from "../src/daemon/agent-runtimes/policy.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { conversationItems } from "../src/daemon/agent.js";
import {
  NativeCodingSession,
  NativeSessionExpiredError,
} from "../src/daemon/agent-runtimes/native-session.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  setAgentProcessSpawner(undefined);
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface FakeCli {
  exited?: boolean;
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
        cli.exited = true;
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
    limits: (limits) => calls.push(`limits:${JSON.stringify(limits)}`),
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
  toolName = "echo_tool",
): Promise<DriverContext> {
  const privateDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-agent-"),
  );
  cleanup.push(() => rm(privateDirectory, { recursive: true, force: true }));
  const echo = defineTool({
    name: toolName,
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
  it("reports a missing resumed session returned as a terminal CLI error", async () => {
    fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type === "user")
        cli.send({
          type: "result",
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID: expired"],
        });
    });
    const driver = new ClaudeCodeDriver(await context({ resume: "expired" }));
    cleanup.push(() => driver.dispose());
    await expect(
      driver.runTurn(
        { text: "continue", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NativeSessionExpiredError);
  });

  it("checks every tool through the policy hook, including reads that need no native approval", async () => {
    let decision: unknown;
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
      if (message.type === "user")
        cli.send({
          type: "control_request",
          request_id: "hook",
          request: {
            subtype: "hook_callback",
            callback_id: "ohmygame-policy",
            tool_use_id: "read-1",
            input: {
              hook_event_name: "PreToolUse",
              tool_name: "Read",
              tool_input: { file_path: "/tmp/secrets/auth.json" },
            },
          },
        });
      if (
        message.type === "control_response" &&
        (message.response as Record<string, unknown>).request_id === "hook"
      ) {
        decision = (
          (message.response as Record<string, unknown>).response as Record<
            string,
            unknown
          >
        ).hookSpecificOutput;
        cli.send({ type: "result", subtype: "success" });
      }
    });
    const driver = new ClaudeCodeDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    await driver.runTurn(
      { text: "read protected file", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(clis).toHaveLength(1);
    expect(decision).toMatchObject({ permissionDecision: "deny" });
    expect(recorded.asked).toEqual([]);
  });

  it("lets Claude Code's own bookkeeping tools run without asking and points planning at update_plan", async () => {
    const hook = async (
      tool: string,
      readOnly: boolean,
      toolInput: Record<string, unknown> = tool === "Write"
        ? { file_path: "/tmp/workspace/a.txt" }
        : {},
    ) => {
      let output: Record<string, unknown> | undefined;
      fakeCli((message, cli) => {
        if (message.type === "control_request")
          cli.send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {},
            },
          });
        if (message.type === "user")
          cli.send({
            type: "control_request",
            request_id: "hook",
            request: {
              subtype: "hook_callback",
              callback_id: "ohmygame-policy",
              tool_use_id: `${tool}-1`,
              input: {
                hook_event_name: "PreToolUse",
                tool_name: tool,
                tool_input: toolInput,
              },
            },
          });
        if (
          message.type === "control_response" &&
          (message.response as Record<string, unknown>).request_id === "hook"
        ) {
          output = (
            (message.response as Record<string, unknown>).response as Record<
              string,
              Record<string, unknown>
            >
          ).hookSpecificOutput;
          cli.send({ type: "result", subtype: "success" });
        }
      });
      const driverContext = await context();
      // Claude Code runs commands in its sandbox; planning still may not change anything.
      driverContext.policy = {
        ...driverContext.policy,
        sandboxedCommands: true,
      };
      const driver = new ClaudeCodeDriver(driverContext);
      cleanup.push(() => driver.dispose());
      const recorded = recordingSink(() => "allow");
      await driver.runTurn(
        { text: "work", images: [], readOnly },
        recorded.sink,
        new AbortController().signal,
      );
      return { output, asked: recorded.asked.length };
    };
    for (const tool of ["TodoWrite", "Skill", "Task", "WebSearch"])
      for (const readOnly of [false, true])
        expect(await hook(tool, readOnly)).toEqual({
          output: expect.objectContaining({ permissionDecision: "allow" }),
          asked: 0,
        });
    expect(await hook("ExitPlanMode", true)).toEqual({
      output: expect.objectContaining({
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("update_plan"),
      }),
      asked: 0,
    });
    expect(await hook("Write", true)).toEqual({
      output: expect.objectContaining({ permissionDecision: "deny" }),
      asked: 0,
    });
    // Current CLIs have no Glob/Grep: planning may run read commands the policy allows, and nothing else.
    for (const [command, decision] of [
      ["grep -rn player src", "allow"],
      ["ls -la", "allow"],
      ["touch a.txt", "deny"],
      ["cat a.txt > b.txt", "deny"],
    ] as const)
      expect(await hook("Bash", true, { command })).toEqual({
        output: expect.objectContaining({ permissionDecision: decision }),
        asked: 0,
      });
    expect(await hook("Bash", true, { command: "npm install" })).toEqual({
      output: expect.objectContaining({ permissionDecision: "deny" }),
      asked: 0,
    });
    expect(await hook("Bash", false, { command: "npm install" })).toEqual({
      output: expect.objectContaining({ permissionDecision: "allow" }),
      asked: 0,
    });
    expect(await hook("Write", false)).toEqual({
      output: expect.objectContaining({ permissionDecision: "allow" }),
      asked: 0,
    });
  });

  it("reports Claude's subscription windows, keeping each until it is reported again", async () => {
    fakeCli((message, cli) => {
      if (message.type === "control_request")
        cli.send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {},
          },
        });
      if (message.type !== "user") return;
      cli.send({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { utilization: 0.13, resetsAt: 100 },
            seven_day: { utilization: 0.33, resetsAt: 200 },
          },
        },
      });
      // An older CLI reports only the window that limits it now.
      cli.send({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 1.2,
          resetsAt: 100,
        },
      });
      cli.send({ type: "result", subtype: "success" });
    });
    const driver = new ClaudeCodeDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    await driver.runTurn(
      { text: "work", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    const reports = recorded.calls
      .filter((call) => call.startsWith("limits:"))
      .map((call) => JSON.parse(call.slice("limits:".length)));
    expect(reports.at(-1)).toEqual([
      {
        id: "claude/five_hour",
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: 100,
      },
      {
        id: "claude/seven_day",
        usedPercent: 33,
        windowMinutes: 10080,
        resetsAt: 200,
      },
    ]);
  });

  it("runs without its sandbox or session caches in full access", async () => {
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
      if (message.type === "user")
        cli.send({ type: "result", subtype: "success" });
    });
    const full = await context();
    full.policy = { ...full.policy, fullAccess: true };
    const driver = new ClaudeCodeDriver(full);
    cleanup.push(() => driver.dispose());
    await driver.runTurn(
      { text: "work", images: [], readOnly: false },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(clis[0]!.args).not.toContain("--settings");
    expect(clis[0]!.env).not.toHaveProperty("npm_config_cache");
  });

  it("shows an allowed Claude tool as running until its result, whichever is reported first", async () => {
    for (const hookFirst of [false, true]) {
      const toolUse = {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      };
      fakeCli((message, cli) => {
        if (message.type === "control_request")
          cli.send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {},
            },
          });
        if (message.type === "user") {
          if (!hookFirst) cli.send(toolUse);
          cli.send({
            type: "control_request",
            request_id: "hook",
            request: {
              subtype: "hook_callback",
              callback_id: "ohmygame-policy",
              tool_use_id: "t1",
              input: {
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: "ls" },
              },
            },
          });
        }
        if (
          message.type === "control_response" &&
          (message.response as Record<string, unknown>).request_id === "hook"
        ) {
          if (hookFirst) cli.send(toolUse);
          cli.send({
            type: "user",
            parent_tool_use_id: null,
            message: {
              content: [
                { type: "tool_result", tool_use_id: "t1", content: "a.txt" },
              ],
            },
          });
          cli.send({ type: "result", subtype: "success" });
        }
      });
      const driver = new ClaudeCodeDriver(await context());
      cleanup.push(() => driver.dispose());
      const recorded = recordingSink();
      await driver.runTurn(
        { text: "list", images: [], readOnly: false },
        recorded.sink,
        new AbortController().signal,
      );
      const tool = recorded.calls.filter((call) => call.includes(":t1"));
      expect(tool.at(-1)).toBe("toolResult:t1:false");
      // An early start for a call not yet reported is ignored by the recorder; the replay counts.
      expect(tool.lastIndexOf("toolStarted:t1")).toBeGreaterThan(
        tool.findIndex((call) => call.startsWith("toolCall:t1")),
      );
    }
  });

  it("stops a native process when interrupt is acknowledged without a terminal result", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
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
      if (message.type === "user") started();
    });
    const ctx = await context();
    const session = new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager: SessionManager.inMemory(ctx.workspacePath),
      toolNames: [],
      cancellationTimeoutMs: 10,
      createDriver: () => new ClaudeCodeDriver(ctx),
      requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("wait");
    await ready;
    await session.abort();
    await run;
    expect(clis[0]!.exited).toBe(true);
  });

  it("does not send input after cancellation during initialize", async () => {
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const users: unknown[] = [];
    fakeCli((message) => {
      if (message.type === "spawned") spawned();
      if (message.type === "user") users.push(message);
    });
    const ctx = await context();
    const session = new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager: SessionManager.inMemory(ctx.workspacePath),
      toolNames: [],
      cancellationTimeoutMs: 10,
      createDriver: () => new ClaudeCodeDriver(ctx),
      requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("cancel during startup");
    await ready;
    await session.abort();
    await run;
    expect(users).toEqual([]);
  });

  it("forwards a native effort without filtering it through a hard-coded Pi enum", async () => {
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
      if (message.type === "user")
        cli.send({ type: "result", subtype: "success" });
    });
    const driver = new ClaudeCodeDriver(
      await context({ reasoningLevel: "custom-effort" }),
    );
    cleanup.push(() => driver.dispose());
    await driver.runTurn(
      { text: "go", images: [], readOnly: false },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(clis[0]!.args).toEqual(
      expect.arrayContaining(["--effort", "custom-effort"]),
    );
  });

  it("does not launch any CLI for an already aborted turn", async () => {
    const clis = fakeCli(() => {});
    const ctx = await context();
    const controller = new AbortController();
    controller.abort();
    for (const Driver of [ClaudeCodeDriver, CodexDriver, OpenCodeDriver]) {
      const driver = new Driver(ctx);
      expect(
        await driver.runTurn(
          { text: "cancelled", images: [], readOnly: false },
          recordingSink().sink,
          controller.signal,
        ),
      ).toEqual({ status: "aborted" });
      await driver.dispose();
    }
    expect(clis).toEqual([]);
  });
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
        message: {
          id: "m2",
          content: [{ type: "text", text: "Done" }],
          // The last request; the result below adds up both of the turn's requests.
          usage: {
            input_tokens: 4,
            output_tokens: 5,
            cache_read_input_tokens: 96,
            cache_creation_input_tokens: 0,
          },
        },
      });
      cli.send({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          input_tokens: 14,
          output_tokens: 9,
          cache_read_input_tokens: 186,
          cache_creation_input_tokens: 0,
        },
        modelUsage: { sonnet: { contextWindow: 200_000 } },
      });
    });
    const driverContext = await context();
    const driver = new ClaudeCodeDriver(driverContext);
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
        "--disallowedTools",
        "mcp__ohmygame-studio",
        "--append-system-prompt",
        "Project instructions",
      ]),
    );
    expect(args).not.toContain("--setting-sources");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).toContain("--session-id");
    // Commands run in Claude's OS sandbox: protected roots unreadable, no opting out.
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    const commandTemporary = canonicalPath(
      path.join(driverContext.privateDirectory, "tmp"),
    );
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        denyRead: [canonicalPath("/tmp/secrets")],
        allowRead: [canonicalPath("/tmp/workspace"), commandTemporary],
        allowWrite: [commandTemporary],
      },
    });
    // Work that reports after the turn's result would have no turn to land in.
    // Installs fill session caches, the home folder's being unwritable there.
    expect(clis[0]!.env).toMatchObject({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_DISABLE_CRON: "1",
      npm_config_cache: path.join(
        driverContext.privateDirectory,
        "tmp",
        "npm-cache",
      ),
    });
    expect(recorded.sessionId()).toBe("claude-session-1");
    expect(recorded.calls).toEqual([
      "text:m1:0:Checking",
      "textDone:m1:0",
      'toolCall:toolu_1:echo_tool:{"value":"x"}',
      'toolCall:toolu_2:bash:{"command":"git push"}',
      "toolResult:toolu_1:false",
      "toolResult:toolu_2:true",
      "textDone:m2:0:Done",
      "usage:4:5:200000:100",
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
      await context({ resume: "earlier-session" }),
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
        "default",
      ]),
    );
    expect(clis[0]!.args).not.toContain("--strict-mcp-config");
    // The person's own configuration may connect Claude Code to OhMyGame from outside.
    expect(clis[0]!.args).toEqual(
      expect.arrayContaining(["--disallowedTools", "mcp__ohmygame-studio"]),
    );
  });
});

/** The filesystem of each permission profile Codex is started with. */
async function codexProfiles(
  overrides: Partial<DriverContext> = {},
): Promise<Array<Record<string, unknown>>> {
  let config: Record<string, unknown> = {};
  fakeCli((message, cli) => {
    if (typeof message.method !== "string" || message.id === undefined)
      return;
    const params = message.params as Record<string, unknown>;
    if (message.method === "thread/start")
      config = params.config as Record<string, unknown>;
    cli.send({
      id: message.id,
      result:
        message.method === "thread/start"
          ? {
              thread: { id: "thread-1" },
              activePermissionProfile: { id: params.permissions },
            }
          : {},
    });
    if (message.method === "turn/start")
      setTimeout(() =>
        cli.send({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        }),
      );
  });
  const driver = new CodexDriver(await context(overrides));
  cleanup.push(() => driver.dispose());
  await driver.runTurn(
    { text: "hi", images: [], readOnly: false },
    recordingSink().sink,
    new AbortController().signal,
  );
  const profiles = config.permissions as Record<
    string,
    { filesystem: Record<string, unknown> }
  >;
  expect(Object.keys(profiles)).toHaveLength(2);
  return Object.values(profiles).map(({ filesystem }) => filesystem);
}

describe("Codex adapter", () => {
  const generatedPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

  function imageCli(item: Record<string, unknown>, options: { started?: boolean; duplicate?: boolean } = {}) {
    return fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined) return;
      const params = message.params as Record<string, unknown>;
      cli.send({ id: message.id, result: message.method === "thread/start"
        ? { thread: { id: "image-thread" }, activePermissionProfile: { id: params.permissions } }
        : {} });
      if (message.method !== "turn/start") return;
      setTimeout(() => {
        if (options.started) cli.send({ method: "item/started", params: { item: { ...item, status: "inProgress", result: "" } } });
        cli.send({ method: "item/completed", params: { item } });
        if (options.duplicate) cli.send({ method: "item/completed", params: { item } });
        cli.send({ method: "item/completed", params: { item: { type: "agentMessage", id: "final", text: "Here is your cat." } } });
        cli.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      });
    });
  }

  it.each([true, false])("delivers native images once and waits for project import (started=%s)", async (started) => {
    imageCli({ type: "imageGeneration", id: "cat", status: "completed", revisedPrompt: "Orange cat", result: generatedPng }, { started, duplicate: true });
    let finish!: (path: string) => void;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
    const saveGeneratedImage = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; markImportStarted(); }));
    const driver = new CodexDriver(await context({ saveGeneratedImage }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    let completed = false;
    const run = driver.runTurn({ text: "cat", images: [], readOnly: false }, recorded.sink, new AbortController().signal)
      .then((outcome) => { completed = true; return outcome; });
    await importStarted;
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    expect(saveGeneratedImage).toHaveBeenCalledWith(expect.stringMatching(/^codex-[a-f0-9]{24}\.png$/), Buffer.from(generatedPng, "base64"), "Orange cat");
    finish("assets/generated/cat.png");
    expect(await run).toEqual({ status: "completed" });
    expect(recorded.results.get("cat")).toMatchObject({ isError: false, result: {
      details: { artifact: { type: "image", path: "assets/generated/cat.png", mediaType: "image/png" } },
    } });
    expect(recorded.calls.filter((call) => call.startsWith("toolResult:cat:"))).toHaveLength(1);
  });

  it.each(["failed", "invalid", "save", "planning"])("surfaces %s native image delivery failures", async (failure) => {
    imageCli({ type: "imageGeneration", id: "cat", status: failure === "failed" ? "failed" : "completed", result: failure === "invalid" ? "not-an-image" : generatedPng });
    const saveGeneratedImage = vi.fn(async () => {
      if (failure === "save") throw new Error("disk full");
      return "assets/generated/cat.png";
    });
    const driver = new CodexDriver(await context({ saveGeneratedImage }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    expect(await driver.runTurn({ text: "cat", images: [], readOnly: failure === "planning" }, recorded.sink, new AbortController().signal))
      .toMatchObject({ status: "failed", error: expect.stringContaining("Codex image could not be delivered") });
    expect(recorded.results.get("cat")?.isError).toBe(true);
    if (failure !== "save") expect(saveGeneratedImage).not.toHaveBeenCalled();
  });

  it("does not publish a late image result after cancellation", async () => {
    imageCli({ type: "imageGeneration", id: "cat", status: "completed", result: generatedPng });
    let finish!: (path: string) => void;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
    const saveGeneratedImage = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; markImportStarted(); }));
    const driver = new CodexDriver(await context({ saveGeneratedImage }));
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    const abort = new AbortController();
    const run = driver.runTurn({ text: "cat", images: [], readOnly: false }, recorded.sink, abort.signal);
    await importStarted;
    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    abort.abort();
    finish("assets/generated/cat.png");
    expect(await run).toEqual({ status: "aborted" });
    expect(recorded.results.size).toBe(0);
  });

  it("retains the project artifact across a transcript reopen without storing image Base64", async () => {
    imageCli({ type: "imageGeneration", id: "cat", status: "completed", result: generatedPng });
    const ctx = await context();
    const savedPath = path.join(ctx.privateDirectory, "cat.png");
    ctx.saveGeneratedImage = async (_name, bytes) => {
      await writeFile(savedPath, bytes);
      return "assets/generated/cat.png";
    };
    const manager = SessionManager.create(ctx.workspacePath, ctx.privateDirectory);
    const session = new NativeCodingSession({
      runtime: "codex-cli", model: "gpt-test", sessionManager: manager, toolNames: [],
      createDriver: () => new CodexDriver(ctx), requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    await session.prompt("Generate a cat");
    expect(await readFile(savedPath)).toEqual(Buffer.from(generatedPng, "base64"));
    const transcript = await readFile(manager.getSessionFile()!, "utf8");
    expect(transcript).not.toContain(generatedPng);
    const reopened = SessionManager.open(manager.getSessionFile()!);
    expect(conversationItems(reopened.getBranch())).toContainEqual(expect.objectContaining({
      type: "dynamicToolCall", tool: "generate_image", status: "completed",
      artifact: { type: "image", path: "assets/generated/cat.png", mediaType: "image/png" },
    }));
  });

  it("fails before sending input when the CLI ignores named filesystem permissions", async () => {
    const methods: string[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      methods.push(message.method);
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start"
            ? { thread: { id: "old-thread" } }
            : {},
      });
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    expect(
      await driver.runTurn(
        { text: "must not send", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("filesystem permissions"),
    });
    expect(methods).not.toContain("turn/start");
  });

  it("registers every OhMyGame tool when a thread starts in planning, so later turns can use them", async () => {
    const threads: Array<Record<string, unknown>> = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "thread/start") threads.push(params);
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start" ||
          message.method === "thread/resume"
            ? {
                thread: { id: "thread-1" },
                activePermissionProfile: { id: params.permissions },
              }
            : {},
      });
      if (message.method === "turn/start")
        setTimeout(() =>
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
    });
    const driverContext = await context();
    // A planning turn offers only the read-only tools; echo_tool stands for a media tool here.
    driverContext.bridge.setActive([]);
    const driver = new CodexDriver(driverContext);
    cleanup.push(() => driver.dispose());
    for (const readOnly of [true, false])
      expect(
        await driver.runTurn(
          { text: "plan, then build", images: [], readOnly },
          recordingSink().sink,
          new AbortController().signal,
        ),
      ).toEqual({ status: "completed" });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.dynamicTools).toEqual([
      expect.objectContaining({ name: "ohmygame_echo_tool" }),
    ]);
  });

  it("uses Codex's own full-access profile for work and keeps planning read-only", async () => {
    const profiles: unknown[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (
        ["thread/start", "thread/resume", "turn/start"].includes(message.method)
      )
        profiles.push(params.permissions);
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start" ||
          message.method === "thread/resume"
            ? {
                thread: { id: "thread-1" },
                activePermissionProfile: { id: params.permissions },
              }
            : {},
      });
      if (message.method === "turn/start")
        setTimeout(() =>
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
    });
    const full = await context();
    full.policy = { ...full.policy, fullAccess: true };
    const driver = new CodexDriver(full);
    cleanup.push(() => driver.dispose());
    for (const readOnly of [false, true])
      expect(
        await driver.runTurn(
          { text: "go", images: [], readOnly },
          recordingSink().sink,
          new AbortController().signal,
        ),
      ).toEqual({ status: "completed" });
    // Work runs unsandboxed; the planning turn names the read-only profile.
    expect(profiles.slice(0, 2)).toEqual([
      ":danger-full-access",
      ":danger-full-access",
    ]);
    expect(profiles.at(-1)).toMatch(/^ohmygame-.*-read$/);
  });

  it("leaves out an external OhMyGame connection from the person's own configuration", async () => {
    let config: Record<string, unknown> = {};
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "thread/start")
        config = params.config as Record<string, unknown>;
      cli.send({
        id: message.id,
        result:
          message.method === "config/read"
            ? {
                config: {
                  mcp_servers: {
                    personal: { command: "x" },
                    "ohmygame-studio": { command: "ohmygame-mcp" },
                  },
                },
              }
            : message.method === "thread/start"
              ? {
                  thread: { id: "thread-1" },
                  activePermissionProfile: { id: params.permissions },
                }
              : {},
      });
      if (message.method === "turn/start")
        setTimeout(() =>
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    await driver.runTurn(
      { text: "hi", images: [], readOnly: false },
      recordingSink().sink,
      new AbortController().signal,
    );
    expect(config["mcp_servers.ohmygame-studio.enabled"]).toBe(false);
    expect(config).not.toHaveProperty("mcp_servers.personal.enabled");
    expect(config).not.toHaveProperty("notify");
  });

  it("denies the shared temporary folders Codex's minimal access would read", async () => {
    for (const filesystem of await codexProfiles())
      for (const shared of ["/tmp", "/var/tmp"])
        expect(filesystem[canonicalPath(shared)]).toBe(
          process.platform === "win32" ? undefined : "deny",
        );
  });

  it("denies Pi's agent folder in every Codex permission profile", async () => {
    // The desktop app keeps Pi's agent folder beside the data folder.
    const piAgentDirectory = "/tmp/ohmygame/pi-agent";
    const profiles = await codexProfiles({
      policy: {
        workspacePath: "/tmp/workspace",
        neverTouch: neverTouchPaths("/tmp/ohmygame/data", piAgentDirectory),
      },
    });
    for (const filesystem of profiles)
      expect(filesystem[canonicalPath(piAgentDirectory)]).toBe("deny");
  });

  it("shares one app server between conversations and keeps their threads apart", async () => {
    let threads = 0;
    const turns: string[] = [];
    let toolAnswer: unknown;
    const clis = fakeCli((message, cli) => {
      if (message.id === 900 && "result" in message)
        toolAnswer = message.result;
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "thread/start") {
        const id = `thread-${++threads}`;
        return cli.send({
          id: message.id,
          result: {
            thread: { id },
            activePermissionProfile: { id: params.permissions },
          },
        });
      }
      if (message.method === "turn/start") {
        turns.push(String(params.threadId));
        return cli.send({
          id: message.id,
          result: { turn: { id: `turn-${String(params.threadId)}` } },
        });
      }
      cli.send({ id: message.id, result: {} });
    });
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-codex-shared-"),
    );
    const codexServer = { key: `test-${directory}`, directory };
    const first = new CodexDriver(await context({ codexServer }));
    // The second conversation has no tools: a call routed to it would fail.
    const second = new CodexDriver(
      await context({ codexServer, bridge: new ToolBridge([]) }),
    );
    const one = recordingSink();
    const two = recordingSink();
    const firstTurn = first.runTurn(
      { text: "one", images: [], readOnly: false },
      one.sink,
      new AbortController().signal,
    );
    const secondTurn = second.runTurn(
      { text: "two", images: [], readOnly: false },
      two.sink,
      new AbortController().signal,
    );
    // Preparing the shared app server took over two seconds on a Windows runner, past the default wait.
    await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 10_000 });
    expect(clis).toHaveLength(1);
    const cli = clis[0]!;
    // Threads are numbered in the order the conversations asked for them.
    const firstThread = one.sessionId()!;
    const secondThread = two.sessionId()!;
    expect(new Set([firstThread, secondThread]).size).toBe(2);
    // A tool call on the first thread runs with the first conversation's bridge.
    cli.send({
      id: 900,
      method: "item/tool/call",
      params: {
        threadId: firstThread,
        turnId: `turn-${firstThread}`,
        callId: "call-1",
        tool: "echo_tool",
        arguments: { value: "first" },
      },
    });
    await vi.waitFor(() => expect(toolAnswer).toBeDefined());
    expect(toolAnswer).toEqual({
      contentItems: [{ type: "inputText", text: "echo first" }],
      success: true,
    });
    cli.send({
      method: "turn/completed",
      params: {
        threadId: secondThread,
        turn: { id: `turn-${secondThread}`, status: "completed" },
      },
    });
    expect(await secondTurn).toEqual({ status: "completed" });
    let firstSettled = false;
    void firstTurn.then(() => (firstSettled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstSettled).toBe(false);
    cli.send({
      method: "turn/completed",
      params: {
        threadId: firstThread,
        turn: { id: `turn-${firstThread}`, status: "completed" },
      },
    });
    expect(await firstTurn).toEqual({ status: "completed" });
    await second.dispose();
    expect(cli.exited).toBeFalsy();
    await first.dispose();
    expect(cli.exited).toBe(true);
    await expect(stat(directory)).rejects.toThrow();
  });

  it("projects quota windows from initial limits and live updates", async () => {
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const result =
        message.method === "thread/start"
          ? {
              thread: { id: "thread-1" },
              activePermissionProfile: {
                id: (message.params as Record<string, unknown>).permissions,
              },
            }
          : message.method === "account/rateLimits/read"
            ? {
                rateLimitsByLimitId: {
                  codex: {
                    primary: {
                      usedPercent: 25,
                      windowDurationMins: 300,
                      resetsAt: 1234,
                    },
                  },
                },
              }
            : {};
      cli.send({ id: message.id, result });
      if (message.method === "turn/start")
        setTimeout(() => {
          cli.send({
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                secondary: { usedPercent: 120, windowDurationMins: 10080 },
              },
            },
          });
          cli.send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          });
        }, 0);
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink();
    await driver.runTurn(
      { text: "quota", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(recorded.calls).toContain(
      'limits:[{"id":"codex/primary","usedPercent":25,"windowMinutes":300,"resetsAt":1234}]',
    );
    expect(recorded.calls).toContain(
      'limits:[{"id":"codex/secondary","usedPercent":100,"windowMinutes":10080}]',
    );
  });

  it("reports expired resume to the shared session without silently creating an empty thread", async () => {
    const methods: string[] = [];
    fakeCli((message, cli) => {
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      methods.push(message.method);
      cli.send(
        message.method === "thread/resume"
          ? { id: message.id, error: { message: "thread not found" } }
          : { id: message.id, result: {} },
      );
    });
    const driver = new CodexDriver(await context({ resume: "expired" }));
    cleanup.push(() => driver.dispose());
    await expect(
      driver.runTurn(
        { text: "continue", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NativeSessionExpiredError);
    expect(methods).not.toContain("thread/start");
  });

  it("denies protected permission roots and shows all allowed roots before granting", async () => {
    const answers: Array<Record<string, unknown>> = [];
    fakeCli((message, cli) => {
      if (typeof message.id === "string" && message.id.startsWith("grant-")) {
        answers.push(message.result as Record<string, unknown>);
        if (message.id === "grant-denied")
          cli.send({
            id: "grant-glob",
            method: "item/permissions/requestApproval",
            params: {
              permissions: { fileSystem: { read: ["/tmp/**"], write: null } },
            },
          });
        else if (message.id === "grant-glob")
          cli.send({
            id: "grant-visible",
            method: "item/permissions/requestApproval",
            params: {
              permissions: {
                fileSystem: {
                  read: ["/tmp/reference"],
                  write: null,
                  entries: [
                    {
                      path: { type: "path", path: "/tmp/reference" },
                      access: "read",
                    },
                  ],
                },
                network: { enabled: true },
              },
              reason: "Read reference files",
            },
          });
        else
          cli.send({
            method: "turn/completed",
            params: { turn: { id: "turn-1", status: "completed" } },
          });
        return;
      }
      if (!message.method || message.id === undefined) return;
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start"
            ? {
                thread: { id: "thread-1" },
                activePermissionProfile: {
                  id: (message.params as Record<string, unknown>).permissions,
                },
              }
            : message.method === "turn/start"
              ? { turn: { id: "turn-1" } }
              : {},
      });
      if (message.method === "turn/start")
        setTimeout(
          () =>
            cli.send({
              id: "grant-denied",
              method: "item/permissions/requestApproval",
              params: {
                permissions: {
                  fileSystem: { read: ["/tmp/secrets/auth.json"], write: null },
                },
              },
            }),
          0,
        );
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    await driver.runTurn(
      { text: "permissions", images: [], readOnly: false },
      recorded.sink,
      new AbortController().signal,
    );
    expect(answers[0]).toEqual({ permissions: {}, scope: "turn" });
    expect(answers[1]).toEqual({ permissions: {}, scope: "turn" });
    expect(recorded.asked).toEqual([
      expect.objectContaining({
        paths: [{ path: "/tmp/reference", access: "read" }],
        network: true,
        canAllowSession: false,
      }),
    ]);
    expect(answers[2]).toMatchObject({
      permissions: {
        fileSystem: { read: ["/tmp/reference"] },
        network: { enabled: true },
      },
      scope: "turn",
    });
  });
  it("rejects write permission grants during a planning turn", async () => {
    let answer: unknown;
    fakeCli((message, cli) => {
      if (message.id === "plan-write") {
        answer = message.result;
        cli.send({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        });
        return;
      }
      if (typeof message.method !== "string" || message.id === undefined)
        return;
      const params = message.params as Record<string, unknown>;
      cli.send({
        id: message.id,
        result:
          message.method === "thread/start"
            ? {
                thread: { id: "plan-thread" },
                activePermissionProfile: { id: params.permissions },
              }
            : {},
      });
      if (message.method === "turn/start") {
        expect(params.permissions).toMatch(/-read$/);
        setTimeout(
          () =>
            cli.send({
              id: "plan-write",
              method: "item/permissions/requestApproval",
              params: {
                permissions: { fileSystem: { write: ["/tmp/workspace/a"] } },
              },
            }),
          0,
        );
      }
    });
    const driver = new CodexDriver(await context());
    cleanup.push(() => driver.dispose());
    const recorded = recordingSink(() => "allow");
    await driver.runTurn(
      { text: "plan", images: [], readOnly: true },
      recorded.sink,
      new AbortController().signal,
    );
    expect(answer).toEqual({ permissions: {}, scope: "turn" });
    expect(recorded.asked).toEqual([]);
  });

  it.each([
    { toolName: "echo_tool", enabled: true },
    { toolName: "mcp", enabled: true },
    { toolName: "mcp", enabled: false },
  ])("runs $toolName (enabled: $enabled) with sandbox approvals", async ({ toolName, enabled }) => {
    const toolResult = {
      contentItems: [
        {
          type: "inputText",
          text: enabled ? "echo y" : `Tool ${toolName} is not available`,
        },
      ],
      success: enabled,
    };
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
        return reply({
          thread: { id: "thread-1" },
          activePermissionProfile: {
            id: (message.params as Record<string, unknown>).permissions,
          },
        });
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
          tool: `ohmygame_${toolName}`,
          arguments: { value: "y" },
        },
      });
      expect(
        await fromServer(cli, "item/tool/call", {
          ...turn,
          callId: "call-1",
          tool: `ohmygame_${toolName}`,
          arguments: { value: "y" },
        }),
      ).toEqual(toolResult);
      notify(cli, "item/completed", {
        ...turn,
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          tool: `ohmygame_${toolName}`,
          ...toolResult,
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
          last: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 5 },
          modelContextWindow: 400_000,
        },
      });
      notify(cli, "turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
    });
    const driverContext = await context({ model: "gpt-5.6-sol" }, toolName);
    driverContext.bridge.setActive(enabled ? [toolName] : []);
    const driver = new CodexDriver(driverContext);
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
      approvalPolicy: {
        granular: { sandbox_approval: false, request_permissions: true },
      },
      permissions: expect.stringMatching(/^ohmygame-/),
      developerInstructions: "Project instructions",
      // Only the workspace's own AGENTS.md counts, as for OhMyGame's own agent.
      config: {
        project_root_markers: [],
        // Commands keep the given PATH rather than a login shell's.
        allow_login_shell: false,
      },
    });
    expect(thread.config).not.toHaveProperty("mcp_servers.personal.enabled");
    expect(thread.config).not.toHaveProperty("notify");
    expect(thread.dynamicTools).toEqual([
      expect.objectContaining({ type: "function", name: `ohmygame_${toolName}` }),
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
      `toolCall:call-1:${toolName}:{"value":"y"}`,
      "toolStarted:call-1",
      `toolResult:call-1:${!enabled}`,
      'toolCall:cmd-1:bash:{"command":"touch /tmp/workspace/a"}',
      "toolStarted:cmd-1",
      "toolResult:cmd-1:true",
      "usage:10:5:400000:35",
    ]);
    expect(recorded.results.get("call-1")?.result.details).toEqual(
      enabled ? {
        artifact: { type: "image", path: "art.png", mediaType: "image/png" },
      } : undefined,
    );
    expect(recorded.asked).toEqual([]);
    expect(turn).not.toHaveProperty("sandboxPolicy");
    expect(turn.permissions).toBe(thread.permissions);
    expect(
      (thread.config as Record<string, unknown>).permissions,
    ).toMatchObject({
      [String(thread.permissions)]: {
        filesystem: {
          ":minimal": "read",
          [canonicalPath("/tmp/secrets")]: "deny",
          ":workspace_roots": { ".": "write" },
        },
      },
      [`${thread.permissions}-read`]: {
        filesystem: { ":workspace_roots": { ".": "read" } },
      },
    });
  });
});

describe("OpenCode adapter", () => {
  it("cancels startup before OpenCode announces its listening address", async () => {
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const clis = fakeCli((message) => {
      if (message.type === "spawned") spawned();
    });
    const ctx = await context();
    const session = new NativeCodingSession({
      runtime: "opencode-cli",
      model: "test/model",
      sessionManager: SessionManager.inMemory(ctx.workspacePath),
      toolNames: [],
      cancellationTimeoutMs: 10,
      createDriver: () => new OpenCodeDriver(ctx),
      requestApproval: async () => "deny",
    });
    cleanup.push(() => session.dispose());
    const run = session.prompt("cancel startup");
    await ready;
    await session.abort();
    await run;
    expect(clis[0]!.exited).toBe(true);
  });

  async function openCodeFixture(overrides: Partial<DriverContext> = {}) {
    const ctx = await context({
      model: "anthropic/claude-sonnet-5",
      reasoningLevel: "high",
      ...overrides,
    });
    const sent: Array<{ method: string; route: string; body: unknown }> = [];
    let events: ServerResponse | undefined;
    let sessionPermissions: unknown = [
      { action: "*", resource: "*", effect: "ask" },
    ];
    let saved: unknown[] = [];
    let sessionMissing = false;
    let sessionMoved = false;
    let pendingConfiguration = 0;
    const emit = (type: string, data: Record<string, unknown> = {}) =>
      events?.write(
        `data: ${JSON.stringify({ type, data: { sessionID: "ses_1", ...data } })}\n\n`,
      );
    let prompt: () => void = () => {};
    let modelChanged: () => void = () => {};
    let sessionChecked: () => void = () => {};
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      const route = url.pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      sent.push({ method: request.method!, route, body });
      expect(request.headers.authorization).toMatch(/^Basic /);
      if (route === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        events = response;
        emit("server.connected", {});
        return;
      }
      response.setHeader("content-type", "application/json");
      const reply = (value: unknown) => response.end(JSON.stringify(value));
      if (route === "/api/info") return reply({ version: "2.1.0" });
      if (route === "/api/location") {
        expect(url.searchParams.get("location[directory]")).toBe(
          ctx.workspacePath,
        );
        return reply({
          directory: ctx.workspacePath,
          project: { id: "project", directory: ctx.workspacePath },
        });
      }
      if (route === "/api/permission/saved") return reply({ data: saved });
      if (route === "/api/agent" && pendingConfiguration-- > 0)
        return reply({
          data: [
            {
              id: "build",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
          ],
        });
      if (route === "/api/agent")
        return reply({
          data: ["build", "plan"].map((id) => ({
            id,
            permissions: [
              { action: "*", resource: "*", effect: "ask" },
              { action: "browser", resource: "*", effect: "deny" },
            ],
          })),
        });
      if (route === "/api/session" && request.method === "POST")
        return reply({ data: { id: "ses_1" } });
      if (route === "/api/session/ses_1") {
        if (sessionMissing) return response.writeHead(404).end("{}");
        if (request.method === "PATCH") {
          sessionPermissions = body.permissions;
          return response.writeHead(204).end();
        }
        sessionChecked();
        return reply({
          data: {
            id: "ses_1",
            location: {
              directory: sessionMoved
                ? "/another-workspace"
                : ctx.workspacePath,
            },
            permissions: sessionPermissions,
          },
        });
      }
      if (route.endsWith("/prompt")) {
        response.end("{}");
        emit("session.execution.started");
        prompt();
        return;
      }
      if (route.endsWith("/interrupt")) {
        response.end("{}");
        emit("session.execution.interrupted");
        return;
      }
      if (route.endsWith("/compact")) {
        response.end("{}");
        emit("session.compaction.started", { reason: "manual" });
        emit("session.compaction.ended", { reason: "manual", text: "summary" });
        emit("session.execution.succeeded");
        return;
      }
      if (route.includes("/permission/")) {
        response.writeHead(204).end();
        return;
      }
      if (route.endsWith("/model")) modelChanged();
      if (route.endsWith("/agent") || route.endsWith("/model"))
        return response.writeHead(204).end();
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          events?.end();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const port = (server.address() as { port: number }).port;
    const clis = fakeCli((message, cli) => {
      if (message.type === "spawned")
        queueMicrotask(() => cli.send({ url: `http://127.0.0.1:${port}` }));
    });
    const driver = new OpenCodeDriver(ctx);
    cleanup.push(() => driver.dispose());
    return {
      driver,
      ctx,
      clis,
      sent,
      emit,
      onPrompt: (callback: () => void) => {
        prompt = callback;
      },
      saveGrant: () => {
        saved = [{ id: "grant", projectID: "project" }];
      },
      missing: () => {
        sessionMissing = true;
      },
      move: () => {
        sessionMoved = true;
      },
      deferConfiguration: () => {
        pendingConfiguration = 2;
      },
      onModelChange: (callback: () => void) => {
        modelChanged = callback;
      },
      onSessionCheck: (callback: () => void) => {
        sessionChecked = callback;
      },
    };
  }

  it("waits for v2 configuration transforms before offering a turn", async () => {
    const f = await openCodeFixture();
    f.deferConfiguration();
    f.onPrompt(() => f.emit("session.execution.succeeded"));
    expect(
      await f.driver.runTurn(
        { text: "go", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).toEqual({ status: "completed" });
    expect(f.sent.filter((r) => r.route === "/api/agent")).toHaveLength(3);
    expect(f.sent.findIndex((r) => r.route === "/api/session")).toBeGreaterThan(
      f.sent.findLastIndex((r) => r.route === "/api/agent"),
    );
  });

  it("does not send a late prompt when cancellation arrives while selecting the model", async () => {
    const f = await openCodeFixture();
    const controller = new AbortController();
    f.onModelChange(() => controller.abort());
    expect(
      await f.driver.runTurn(
        { text: "cancel", images: [], readOnly: false },
        recordingSink().sink,
        controller.signal,
      ),
    ).toEqual({ status: "aborted" });
    expect(f.sent.some((r) => r.route.endsWith("/prompt"))).toBe(false);
  });

  it("does not start compaction after cancellation, including during session setup", async () => {
    for (const phase of ["before-start", "session-setup"]) {
      const f = await openCodeFixture();
      const recorded = recordingSink();
      const controller = new AbortController();
      if (phase === "before-start") controller.abort();
      else f.onSessionCheck(() => controller.abort());
      await f.driver.compact(recorded.sink, controller.signal);
      expect(f.sent.some((r) => r.route.endsWith("/compact"))).toBe(false);
      expect(recorded.calls.filter((c) => c.startsWith("compaction:"))).toEqual([]);
      if (phase === "before-start") expect(f.clis).toEqual([]);
    }
  });

  it("drives v2 messages, images, thinking, tools, usage and planning permissions", async () => {
    const f = await openCodeFixture();
    const recorded = recordingSink();
    f.onPrompt(() => {
      f.emit("session.reasoning.started", {
        assistantMessageID: "msg_a",
        ordinal: 0,
      });
      f.emit("session.reasoning.delta", {
        assistantMessageID: "msg_a",
        ordinal: 0,
        delta: "Thinking",
      });
      f.emit("session.reasoning.ended", {
        assistantMessageID: "msg_a",
        ordinal: 0,
        text: "Thinking",
      });
      f.emit("session.tool.input.started", {
        assistantMessageID: "msg_a",
        id: "call_1",
        name: "shell",
      });
      f.emit("session.tool.input.delta", {
        assistantMessageID: "msg_a",
        id: "call_1",
        delta: '{"command":',
      });
      f.emit("session.tool.called", {
        assistantMessageID: "msg_a",
        id: "call_1",
        input: { command: "sudo ls" },
        executed: true,
      });
      f.emit("permission.asked", {
        id: "per_1",
        action: "shell",
        resources: ["sudo ls"],
        metadata: { command: "sudo ls" },
        source: { type: "tool", id: "call_1", messageID: "msg_a" },
      });
      f.emit("permission.asked", {
        id: "per_2",
        action: "subagent",
        resources: ["explore"],
        metadata: {},
        save: ["*"],
      });
    });
    const run = f.driver.runTurn(
      {
        text: "go",
        images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        readOnly: true,
      },
      recorded.sink,
      new AbortController().signal,
    );
    await expect
      .poll(
        () =>
          f.sent.filter(
            (r) => r.route.includes("/permission/") && r.method === "POST",
          ).length,
      )
      .toBe(2);
    f.emit("session.tool.failed", {
      id: "call_1",
      error: { type: "declined", message: "rejected" },
      executed: true,
    });
    f.emit("session.text.ended", {
      assistantMessageID: "msg_a",
      ordinal: 1,
      text: "Could not",
    });
    f.emit("session.step.ended", {
      assistantMessageID: "msg_a",
      tokens: { input: 30, output: 4, cache: { read: 10, write: 0 } },
    });
    f.emit("session.execution.succeeded");
    expect(await run).toEqual({ status: "completed" });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/model",
      body: {
        model: {
          providerID: "anthropic",
          id: "claude-sonnet-5",
          variant: "high",
        },
      },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/agent",
      body: { agent: "plan" },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/prompt",
      body: {
        text: "go",
        files: [{ name: "image-1", uri: "data:image/png;base64,aGVsbG8=" }],
      },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/permission/per_1/reply",
      body: {
        decision: "reject",
        message: expect.stringContaining("planning turn"),
      },
    });
    expect(f.sent).toContainEqual({
      method: "POST",
      route: "/api/session/ses_1/permission/per_2/reply",
      body: { decision: "once" },
    });
    expect(recorded.asked).toEqual([]);
    expect(recorded.sessionId()).toBe("opencode-v2:ses_1");
    expect(recorded.calls).toEqual([
      "thinking:msg_a:reasoning:0:Thinking",
      "thinkingDone:msg_a:reasoning:0",
      'toolCall:call_1:bash:{"command":"sudo ls"}',
      "toolStarted:call_1",
      "toolResult:call_1:true",
      "text:msg_a:text:1:Could not",
      "textDone:msg_a:text:1:Could not",
      "usage:30:4::40",
    ]);
    expect(f.clis[0]!.args).toEqual([
      "serve",
      "--stdio",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(JSON.parse(f.clis[0]!.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      snapshots: false,
      share: "disabled",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });
    const config = JSON.parse(f.clis[0]!.env.OPENCODE_CONFIG_CONTENT!);
    expect(await readFile(config.instructions[0], "utf8")).toBe(
      "Project instructions",
    );
    expect(f.clis[0]!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
  });

  it("resumes a v2 session, reapplies permissions, compacts it and reports terminal failures", async () => {
    const f = await openCodeFixture({ resume: "opencode-v2:ses_1" });
    const recorded = recordingSink();
    f.onPrompt(() =>
      f.emit("session.execution.failed", {
        error: { type: "provider", message: "No model access" },
      }),
    );
    expect(
      await f.driver.runTurn(
        { text: "go", images: [], readOnly: false },
        recorded.sink,
        new AbortController().signal,
      ),
    ).toEqual({ status: "failed", error: "No model access" });
    expect(
      f.sent.some((r) => r.route === "/api/session" && r.method === "POST"),
    ).toBe(false);
    expect(f.sent).toContainEqual({
      method: "PATCH",
      route: "/api/session/ses_1",
      body: { permissions: [{ action: "*", resource: "*", effect: "ask" }] },
    });
    await f.driver.compact(recorded.sink, new AbortController().signal);
    expect(recorded.calls.filter((c) => c.startsWith("compaction:"))).toEqual([
      "compaction:start",
      "compaction:end",
    ]);
    f.saveGrant();
    expect(
      await f.driver.runTurn(
        { text: "again", images: [], readOnly: false },
        recorded.sink,
        new AbortController().signal,
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("saved permissions"),
    });
    expect(f.sent.filter((r) => r.route.endsWith("/prompt"))).toHaveLength(1);
  });

  it("rebuilds a native session moved out of the app workspace", async () => {
    const f = await openCodeFixture({ resume: "opencode-v2:ses_1" });
    f.move();
    await expect(
      f.driver.runTurn(
        { text: "resume", images: [], readOnly: false },
        recordingSink().sink,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(NativeSessionExpiredError);
    expect(f.sent.some((r) => r.route.endsWith("/prompt"))).toBe(false);
  });

  it.each(["ses_legacy", "opencode-v2:ses_1"])(
    "rebuilds expired or v1 context %s through the shared handoff",
    async (resume) => {
      const f = await openCodeFixture({ resume });
      f.missing();
      await expect(
        f.driver.runTurn(
          { text: "resume", images: [], readOnly: false },
          recordingSink().sink,
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(NativeSessionExpiredError);
      expect(f.sent.some((r) => r.route.endsWith("/prompt"))).toBe(false);
    },
  );
});
