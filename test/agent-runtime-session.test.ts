import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentManager, conversationItems } from "../src/daemon/agent.js";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";
import { CHECKPOINT_ENTRY } from "../src/daemon/checkpoint-extension.js";
import type { StoredConversation } from "../src/daemon/conversations.js";
import {
  NATIVE_SESSION_ENTRY,
  NativeCodingSession,
  latestNativeSession,
  type NativeDriver,
  type NativeTurnInput,
  type NativeTurnOutcome,
  type NativeTurnSink,
} from "../src/daemon/agent-runtimes/native-session.js";
import type {
  ProjectState,
  RuntimeEvent,
  ThreadItem,
} from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

type Script = (
  input: NativeTurnInput,
  sink: NativeTurnSink,
  signal: AbortSignal,
) => Promise<NativeTurnOutcome>;

/** A protocol adapter that plays a script for each turn and records what it was given. */
class ScriptedDriver implements NativeDriver {
  readonly inputs: NativeTurnInput[] = [];
  reset = () => {
    this.resets++;
  };
  resets = 0;
  disposed = false;
  constructor(
    private readonly scripts: Script[],
    readonly resume: string | undefined,
  ) {}
  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    this.inputs.push(input);
    const script = this.scripts.shift();
    if (!script) return { status: "completed" };
    return script(input, sink, signal);
  }
  async interrupt(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
  }
}

function setup(
  scripts: Script[],
  options: {
    snapshot?: () => Promise<string>;
    sessionManager?: SessionManager;
  } = {},
) {
  const events = new RuntimeEventBus();
  const project: ProjectState = {
    id: "project-1",
    name: "Project",
    type: "general",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/project-1",
    preview: { status: "waiting" },
  };
  const conversation: StoredConversation = {
    sessionPath: "/tmp/conversation-1.jsonl",
    summary: {
      id: "conversation-1",
      projectId: project.id,
      title: "Conversation",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
  };
  const sessionManager =
    options.sessionManager ?? SessionManager.inMemory("/tmp/project-1");
  const drivers: ScriptedDriver[] = [];
  let manager!: AgentManager;
  const createSession = async () =>
    new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager,
      createDriver: (resume) => {
        const driver = new ScriptedDriver(scripts, resume);
        drivers.push(driver);
        return driver;
      },
      ...(options.snapshot ? { snapshotBeforeMessage: options.snapshot } : {}),
      requestApproval: (details, toolCallId, signal) =>
        manager.askApproval(
          project.id,
          conversation.summary.id,
          toolCallId,
          details,
          signal,
        ),
      toolNames: ["canvas_check"],
    });
  manager = new AgentManager(events, {
    createSession,
    activeToolNames: (_project, mode, session) =>
      projectPiToolNames(
        mode,
        [],
        session.getAllTools?.().map((tool) => tool.name),
      ),
    ...(options.snapshot
      ? {
          checkpoints: {
            snapshot: options.snapshot,
            changed: async () => ({ files: 0, items: [] }),
          },
        }
      : {}),
  });
  const received: RuntimeEvent[] = [];
  events.subscribe(project.id, (event) => received.push(event));
  return { manager, project, conversation, sessionManager, drivers, received };
}

function items(sessionManager: SessionManager): ThreadItem[] {
  return conversationItems(sessionManager.getBranch(), false);
}

describe("coding agent sessions", () => {
  it("records a turn in the conversation the way OhMyGame's own agent does", async () => {
    let commit = 0;
    const { manager, project, conversation, sessionManager, received } = setup(
      [
        async (_input, sink) => {
          sink.nativeSession("native-1");
          sink.thinking("r1", "Planning");
          sink.thinkingDone("r1");
          sink.text("t1", "Checking ");
          sink.text("t1", "the canvas");
          sink.textDone("t1");
          sink.toolCall("call-1", "canvas_check", {});
          sink.toolStarted("call-1");
          sink.toolResult(
            "call-1",
            {
              content: [{ type: "text", text: "ok" }],
              details: {
                artifact: {
                  type: "image",
                  path: "art/cover.png",
                  mediaType: "image/png",
                },
              },
            },
            false,
          );
          sink.text("t2", "Done");
          sink.textDone("t2");
          sink.usage(
            { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
            1_000,
            400,
          );
          return { status: "completed" };
        },
      ],
      { snapshot: async () => (++commit).toString(16).padStart(40, "0") },
    );

    const run = manager.prompt(project, conversation, "Make a cover");
    await expect(run.result).resolves.toBe("completed");

    const stored = items(sessionManager);
    expect(stored.map((item) => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "agentMessage",
      "dynamicToolCall",
      "agentMessage",
    ]);
    expect(stored[0]).toMatchObject({
      type: "userMessage",
      text: "Make a cover",
      checkpointId: expect.any(String),
    });
    expect(stored[3]).toMatchObject({
      type: "dynamicToolCall",
      tool: "canvas_check",
      status: "completed",
      output: "ok",
      artifact: { path: "art/cover.png" },
    });
    expect(stored[4]).toMatchObject({
      type: "agentMessage",
      text: "Done",
      status: "completed",
    });
    // The checkpoint is taken before the message is stored, as Pi's checkpoint extension does.
    const branch = sessionManager.getBranch();
    const checkpoint = branch.findIndex(
      (entry) =>
        entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY,
    );
    const message = branch.findIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(checkpoint).toBeGreaterThanOrEqual(0);
    expect(checkpoint).toBeLessThan(message);
    expect(latestNativeSession(branch, "claude-code-cli")).toEqual({
      version: 1,
      runtime: "claude-code-cli",
      sessionId: "native-1",
    });

    const types = received.map((event) => event.type);
    expect(types).toContain("checkpoint.created");
    expect(types).toContain("item.agentMessage.delta");
    expect(types).toContain("agent.completed");
    expect(types).toContain("checkpoint.completed");
    await expect(manager.contextUsage(project, conversation)).resolves.toEqual({
      tokens: 400,
      contextWindow: 1_000,
      percent: 40,
    });
  });

  it("runs a message sent during a turn after it, in the same run", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, project, conversation, sessionManager, drivers } = setup([
      async (_input, sink) => {
        await held;
        sink.text("a", "first");
        return { status: "completed" };
      },
      async (_input, sink) => {
        sink.text("b", "second");
        return { status: "completed" };
      },
    ]);
    const run = manager.prompt(project, conversation, "one");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = manager.prompt(project, conversation, "two");
    expect(queued.queued).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await run.result;
    await queued.result;
    expect(drivers[0]!.inputs.map((input) => input.text)).toEqual([
      "one",
      "two",
    ]);
    expect(
      items(sessionManager)
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.type === "agentMessage" && item.text),
    ).toEqual(["first", "second"]);
  });

  it("stops a turn and keeps what the agent said before it was stopped", async () => {
    const { manager, project, conversation, sessionManager, received } = setup([
      async (_input, sink, signal) => {
        sink.text("a", "Working");
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "aborted" };
      },
    ]);
    const run = manager.prompt(project, conversation, "go");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.cancel(project.id, conversation.summary.id, run.turnId);
    await expect(run.result).resolves.toBe("cancelled");
    expect(received.map((event) => event.type)).toContain("agent.cancelled");
    expect(
      items(sessionManager).find((item) => item.type === "agentMessage"),
    ).toMatchObject({ text: "Working", status: "cancelled" });
  });

  it("reports an agent's failure as the turn's error", async () => {
    const { manager, project, conversation, received } = setup([
      async () => ({
        status: "failed",
        error: "Claude Code exited with code 1: not signed in",
      }),
    ]);
    const run = manager.prompt(project, conversation, "go");
    await expect(run.result).rejects.toThrow("not signed in");
    expect(
      received.find((event) => event.type === "agent.error")?.data,
    ).toEqual({ error: "Claude Code exited with code 1: not signed in" });
  });

  it("asks the person and remembers an answer for the conversation", async () => {
    const decisions: string[] = [];
    const { manager, project, conversation, received } = setup([
      async (_input, sink) => {
        const request = {
          kind: "command" as const,
          tool: "Bash",
          command: "git push",
          canAllowSession: true,
        };
        decisions.push(
          await sink.requestApproval(request, { callId: "call-1" }),
        );
        decisions.push(
          await sink.requestApproval(request, { callId: "call-2" }),
        );
        return { status: "completed" };
      },
    ]);
    received.length = 0;
    const run = manager.prompt(project, conversation, "push it");
    await expect
      .poll(() =>
        received.find(
          (event) =>
            event.type === "item.started" &&
            (event.data as { item: ThreadItem }).item.type ===
              "approvalRequest",
        ),
      )
      .toBeTruthy();
    const started = received.find(
      (event) =>
        event.type === "item.started" &&
        (event.data as { item: ThreadItem }).item.type === "approvalRequest",
    )!;
    const item = (
      started.data as { item: Extract<ThreadItem, { type: "approvalRequest" }> }
    ).item;
    expect(item.request.command).toBe("git push");
    expect(() =>
      manager.answerApproval(
        project.id,
        conversation.summary.id,
        "unknown",
        "allow",
      ),
    ).toThrow();
    manager.answerApproval(
      project.id,
      conversation.summary.id,
      item.requestId,
      "allow-session",
    );
    await run.result;
    // The second request matched the first and was not asked again.
    expect(decisions).toEqual(["allow-session", "allow"]);
    expect(
      received.filter(
        (event) =>
          event.type === "item.started" &&
          (event.data as { item: ThreadItem }).item.type === "approvalRequest",
      ),
    ).toHaveLength(1);
  });

  it("denies requests that are still waiting when the turn is stopped", async () => {
    let decision: string | undefined;
    const { manager, project, conversation, received } = setup([
      async (_input, sink, signal) => {
        decision = await sink.requestApproval(
          {
            kind: "file",
            tool: "Write",
            path: "/etc/hosts",
            canAllowSession: false,
          },
          { signal },
        );
        return { status: signal.aborted ? "aborted" : "completed" };
      },
    ]);
    const run = manager.prompt(project, conversation, "edit hosts");
    await expect
      .poll(() =>
        received.some(
          (event) =>
            event.type === "item.started" &&
            (event.data as { item: ThreadItem }).item.type ===
              "approvalRequest",
        ),
      )
      .toBe(true);
    await manager.cancel(project.id, conversation.summary.id, run.turnId);
    await run.result;
    expect(decision).toBe("deny");
  });

  it("starts a new native session with a summary after going back before the one it had", async () => {
    const sessionManager = SessionManager.inMemory("/tmp/project-1");
    const { manager, project, conversation, drivers } = setup(
      [
        async (_input, sink) => {
          sink.nativeSession("native-1");
          sink.text("a", "Made hello.txt");
          return { status: "completed" };
        },
        async (_input, sink) => {
          sink.text("b", "Second answer");
          return { status: "completed" };
        },
        async () => ({ status: "completed" }),
      ],
      { sessionManager },
    );
    await manager.prompt(project, conversation, "make hello").result;
    await manager.prompt(project, conversation, "again").result;
    // Editing the first message goes back to before the native session began.
    const first = sessionManager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!;
    sessionManager.branch(first.id);
    const fresh = new NativeCodingSession({
      runtime: "claude-code-cli",
      model: "sonnet",
      sessionManager,
      createDriver: (resume) => {
        const driver = new ScriptedDriver([], resume);
        drivers.push(driver);
        return driver;
      },
      requestApproval: async () => "deny",
      toolNames: [],
    });
    expect(drivers.at(-1)!.resume).toBeUndefined();
    await fresh.prompt("continue");
    expect(drivers.at(-1)!.inputs[0]!.text).toContain("<conversation-handoff>");
    expect(drivers.at(-1)!.inputs[0]!.text).toContain("User: make hello");
    expect(drivers.at(-1)!.inputs[0]!.text).toMatch(/continue$/);
  });

  it("continues the native session of the same agent and hands off from another one", () => {
    const sessionManager = SessionManager.inMemory("/tmp/project-1");
    sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 1,
      runtime: "claude-code-cli",
      sessionId: "claude-1",
    });
    expect(
      latestNativeSession(sessionManager.getBranch(), "claude-code-cli")
        ?.sessionId,
    ).toBe("claude-1");
    sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 1,
      runtime: "codex-cli",
      sessionId: "codex-1",
    });
    // Codex held the conversation since; Claude Code's session has not seen that.
    expect(
      latestNativeSession(sessionManager.getBranch(), "claude-code-cli"),
    ).toBeUndefined();
    expect(
      latestNativeSession(sessionManager.getBranch(), "codex-cli")?.sessionId,
    ).toBe("codex-1");
  });

  it("marks planning turns read-only from the tools OhMyGame allows", async () => {
    const { manager, project, conversation, drivers } = setup([
      async () => ({ status: "completed" }),
    ]);
    await manager.prompt(project, conversation, "plan it", [], [], "planning")
      .result;
    expect(drivers[0]!.inputs[0]!.readOnly).toBe(true);
  });
});
