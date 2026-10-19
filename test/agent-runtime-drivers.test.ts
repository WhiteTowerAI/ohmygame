import { defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
import { canonicalPath } from "../src/daemon/agent-runtimes/policy.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
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
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--append-system-prompt",
        "Project instructions",
      ]),
    );
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
        "default",
      ]),
    );
    expect(clis[0]!.args).not.toContain("--strict-mcp-config");
  });
});

describe("Codex adapter", () => {
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
      expect.objectContaining({ name: "echo_tool" }),
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

  it("denies the shared temporary folders Codex's minimal access would read", async () => {
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
    const driver = new CodexDriver(await context());
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
    for (const { filesystem } of Object.values(profiles))
      for (const shared of ["/tmp", "/var/tmp"])
        expect(filesystem[canonicalPath(shared)]).toBe(
          process.platform === "win32" ? undefined : "deny",
        );
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
    await vi.waitFor(() => expect(turns).toHaveLength(2));
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
          last: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 5 },
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
      approvalPolicy: {
        granular: { sandbox_approval: false, request_permissions: true },
      },
      permissions: expect.stringMatching(/^ohmygame-/),
      developerInstructions: "Project instructions",
      // Only the workspace's own AGENTS.md counts, as for OhMyGame's own agent.
      config: {
        "mcp_servers.personal.enabled": false,
        notify: [],
        project_root_markers: [],
        // Commands keep the given PATH rather than a login shell's.
        allow_login_shell: false,
      },
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
      "usage:10:5:400000:35",
    ]);
    expect(recorded.results.get("call-1")?.result.details).toEqual({
      artifact: { type: "image", path: "art.png", mediaType: "image/png" },
    });
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
      if (request.url === "/path")
        return response.end(JSON.stringify({ worktree: "/tmp/workspace" }));
      if (request.url === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": connected\n\n");
        events = response;
        return;
      }
      if (request.method === "POST" && request.url === "/session")
        return response.end(JSON.stringify({ id: "ses_1" }));
      const permission = request.url?.match(/^\/permission\/(.+)\/reply$/);
      if (permission) {
        replies.push({ id: permission[1]!, body });
        response.end("true");
        if (replies.length < 2) return;
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
        // A subagent may explore while planning; its own requests are judged like the parent's.
        emit("permission.asked", {
          id: "per_2",
          sessionID: "ses_1",
          permission: "task",
          patterns: ["explore"],
          metadata: { description: "Find the speed" },
          always: ["*"],
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
    expect(replies).toHaveLength(2);
    expect(replies).toEqual(
      expect.arrayContaining([
        {
          id: "per_1",
          body: {
            reply: "reject",
            message: expect.stringContaining("planning turn"),
          },
        },
        { id: "per_2", body: { reply: "once" } },
      ]),
    );
    // Planning turns deny shell execution without offering an override.
    expect(recorded.asked).toEqual([]);
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
