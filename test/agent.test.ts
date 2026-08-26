import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentManager, conversationItems, lastAssistantError, type CodingSession } from "../src/daemon/agent.js";
import type { StoredConversation } from "../src/daemon/conversations.js";
import type { AgentReasoningLevel, ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

describe("lastAssistantError", () => {
  it("surfaces model errors even when Pi resolves the prompt", () => {
    expect(lastAssistantError([
      { role: "user", content: [] },
      { role: "assistant", stopReason: "error", errorMessage: "No API key" },
    ])).toBe("No API key");
  });

  it("does not turn a successful assistant response into an error", () => {
    expect(lastAssistantError([{ role: "assistant", stopReason: "stop" }])).toBeUndefined();
  });
});

describe("conversationItems", () => {
  it("restores the latest structured plan without a visible plan tool", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Build", timestamp: 1 }),
      sessionMessage("assistant-1", {
        role: "assistant",
        content: [{ type: "toolCall", id: "plan-1", name: "update_plan", arguments: {} }],
        stopReason: "toolUse",
      }),
      sessionMessage("plan-result-1", {
        role: "toolResult",
        toolCallId: "plan-1",
        toolName: "update_plan",
        content: [{ type: "text", text: "Plan updated" }],
        details: { plan: { steps: [{ step: "Inspect", status: "in_progress" }] } },
        isError: false,
        timestamp: 2,
      }),
      sessionMessage("assistant-2", {
        role: "assistant",
        content: [{ type: "toolCall", id: "plan-2", name: "update_plan", arguments: {} }],
        stopReason: "toolUse",
      }),
      sessionMessage("plan-result-2", {
        role: "toolResult",
        toolCallId: "plan-2",
        toolName: "update_plan",
        content: [{ type: "text", text: "Plan updated" }],
        details: { plan: { explanation: "Progress", steps: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }] } },
        isError: false,
        timestamp: 3,
      }),
    ] as never, false);

    expect(items.filter((item) => item.kind === "plan")).toEqual([{
      id: "user:plan",
      turnId: "user",
      kind: "plan",
      plan: {
        explanation: "Progress",
        steps: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }],
      },
      timestamp: 3,
    }]);
    expect(items.some((item) => item.kind === "tool")).toBe(false);
  });

  it("infers commentary and final answer phases from Pi stop reasons", () => {
    expect(conversationItems([
      sessionMessage("user", { role: "user", content: "Build", timestamp: 1 }),
      sessionMessage("commentary", {
        role: "assistant",
        content: [{ type: "text", text: "I will inspect it." }, { type: "toolCall", id: "call", name: "read", arguments: { path: "package.json" } }],
        stopReason: "toolUse",
      }),
      sessionMessage("final", {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      }),
      sessionMessage("truncated", {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        stopReason: "length",
      }),
    ] as never).filter((item) => item.kind === "assistant")).toMatchObject([
      { text: "I will inspect it.", phase: "commentary" },
      { text: "Done.", phase: "final_answer" },
      { text: "Partial answer", phase: "final_answer" },
    ]);
  });

  it("restores user, assistant, and tool activity without internal content", () => {
    expect(conversationItems([
      sessionMessage("user-1", { role: "user", content: [{ type: "text", text: "Build a game" }], timestamp: 1 }),
      sessionMessage("assistant-1", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect the files first." },
          { type: "text", text: "I will build it. ", textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }) },
          { type: "toolCall", id: "call-1", name: "write", arguments: { path: "secret", content: "private source" } },
          { type: "text", text: "Starting now.", textSignature: JSON.stringify({ v: 1, id: "commentary-2", phase: "commentary" }) },
        ],
        stopReason: "toolUse",
      }),
      sessionMessage("tool-1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "write",
        content: [{ type: "text", text: "large private output" }],
        isError: false,
        timestamp: 2,
      }),
      sessionMessage("assistant-2", {
        role: "assistant",
        content: [{ type: "text", text: "Done.", phase: "final_answer" }],
        stopReason: "stop",
      }),
    ] as never)).toEqual([
      { id: "user-1", turnId: "user-1", kind: "user", text: "Build a game", timestamp: 1 },
      { id: "assistant-1:thinking:0", turnId: "user-1", kind: "thinking", text: "I should inspect the files first.", status: "complete", timestamp: 0 },
      { id: "assistant-1:assistant:1", turnId: "user-1", kind: "assistant", text: "I will build it. ", status: "complete", phase: "commentary", timestamp: 0 },
      {
        id: "assistant-1:tool:call-1",
        turnId: "user-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "write",
        status: "complete",
        args: { path: "secret" },
        output: "large private output",
        timestamp: 2,
      },
      { id: "assistant-1:assistant:3", turnId: "user-1", kind: "assistant", text: "Starting now.", status: "complete", phase: "commentary", timestamp: 0 },
      { id: "assistant-2:assistant:0", turnId: "user-1", kind: "assistant", text: "Done.", status: "complete", phase: "final_answer", timestamp: 0 },
    ]);
  });

  it("restores assistant errors and cancelled turns", () => {
    expect(conversationItems([
      sessionMessage("error", { role: "assistant", content: [], stopReason: "error", errorMessage: "No API key" }),
      sessionMessage("user", { role: "user", content: "Stop", timestamp: 1 }),
      sessionMessage("cancelled", { role: "assistant", content: [], stopReason: "aborted" }),
    ] as never)).toEqual([
      { id: "error:assistant", turnId: "error", kind: "assistant", text: "", status: "error", error: "No API key", timestamp: 0 },
      { id: "user", turnId: "user", kind: "user", text: "Stop", timestamp: 1 },
      { id: "cancelled:assistant", turnId: "user", kind: "assistant", text: "", status: "cancelled", timestamp: 0 },
    ]);
  });

  it("restores images from Pi user messages", () => {
    expect(conversationItems([
      sessionMessage("user", {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
        timestamp: 1,
      }),
    ] as never, false)).toEqual([{
      id: "user",
      turnId: "user",
      kind: "user",
      text: "",
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      timestamp: 1,
    }]);
  });

  it("marks a turn interrupted when its persisted session has no terminal assistant message", () => {
    expect(conversationItems([
      sessionMessage("user", { role: "user", content: "Build", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "index.html" } }],
        stopReason: "toolUse",
      }),
    ] as never).at(-1)).toMatchObject({ kind: "assistant", status: "interrupted" });
  });

  it("truncates large tool output while keeping its beginning and end", () => {
    const output = `start-${"x".repeat(13_000)}-end`;
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Run", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "test" } }],
        stopReason: "toolUse",
      }),
      sessionMessage("tool", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: output }],
        isError: false,
      }),
    ] as never);

    expect(items[1]).toMatchObject({ kind: "tool", truncated: true });
    expect(items[1]?.kind === "tool" && items[1].output).toContain("start-");
    expect(items[1]?.kind === "tool" && items[1].output).toContain("-end");
  });

  it("keeps only display-safe arguments for built-in tools", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Change it", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "write", name: "write", arguments: { path: "src/app.ts", content: "private source" } },
          { type: "toolCall", id: "edit", name: "edit", arguments: { path: "src/app.ts", oldText: "private", newText: "source" } },
          { type: "toolCall", id: "read", name: "read", arguments: { path: "src/app.ts", offset: 2, limit: 20, extra: "drop" } },
          { type: "toolCall", id: "bash", name: "bash", arguments: { command: "npm test", timeout: 30, cwd: "/private" } },
        ],
        stopReason: "toolUse",
      }),
    ] as never).filter((item) => item.kind === "tool");

    expect(items.map((item) => item.args)).toEqual([
      { path: "src/app.ts" },
      { path: "src/app.ts" },
      { path: "src/app.ts", offset: 2, limit: 20 },
      { command: "npm test", timeout: 30 },
    ]);
  });

  it("bounds arguments from custom tools", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Generate", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "custom", name: "custom", arguments: { prompt: "x".repeat(3_000) } }],
        stopReason: "toolUse",
      }),
    ] as never);

    expect(items[1]?.kind === "tool" && typeof items[1].args === "string" && items[1].args.length).toBeLessThan(2_100);
  });

  it("keeps MCP identity when nested tool arguments are large", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Create a scene", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "mcp",
          name: "mcp",
          arguments: {
            server: "opengame-godot",
            tool: "create_scene",
            args: { projectPath: "/game", content: "x".repeat(3_000) },
          },
        }],
        stopReason: "toolUse",
      }),
    ] as never);

    expect(items[1]).toMatchObject({
      kind: "mcp",
      server: "opengame-godot",
      tool: "create_scene",
    });
    expect(items[1]?.kind === "mcp" && typeof items[1].args).toBe("string");
  });

  it("keeps MCP identity for server discovery operations", () => {
    const items = conversationItems([
      sessionMessage("user", { role: "user", content: "Inspect Godot tools", timestamp: 1 }),
      sessionMessage("assistant", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "list", name: "mcp", arguments: { server: "opengame-godot" } },
          { type: "toolCall", id: "search", name: "mcp", arguments: { server: "opengame-godot", search: "scene" } },
          { type: "toolCall", id: "describe", name: "mcp", arguments: { server: "opengame-godot", describe: "opengame-godot_add_node" } },
        ],
        stopReason: "toolUse",
      }),
    ] as never);

    expect(items.slice(1, 4)).toMatchObject([
      { kind: "mcp", server: "opengame-godot", tool: "list_tools" },
      { kind: "mcp", server: "opengame-godot", tool: "search_tools", args: { search: "scene" } },
      { kind: "mcp", server: "opengame-godot", tool: "describe_add_node", args: { describe: "opengame-godot_add_node" } },
    ]);
  });
});

describe("AgentManager", () => {
  it("pauses a planning turn for a questionnaire and resumes it with structured answers", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "Plan this", [], [], "planning").result!;
    await vi.waitFor(() => expect(manager.state(conversation).agent.status).toBe("running"));
    const pending = manager.askQuestionnaire(project.id, conversation.summary.id, {
      questions: [{
        id: "scope",
        prompt: "What should be built first?",
        options: [{ value: "game", label: "A game", recommended: true }, { value: "tool", label: "A tool" }],
      }],
    });
    const request = manager.questionnaire(project.id, conversation.summary.id);
    expect(request?.questions[0]?.options[0]?.recommended).toBe(true);
    expect(events.since(project.id).at(-1)?.type).toBe("questionnaire.requested");

    manager.answerQuestionnaire(project.id, conversation.summary.id, request!.id, [{ questionId: "scope", value: "game" }]);
    await expect(pending).resolves.toMatchObject({ cancelled: false, answers: [{ value: "game", custom: false }] });
    expect(manager.questionnaire(project.id, conversation.summary.id)).toBeUndefined();
    prompt.resolve();
    await expect(run).resolves.toBe("completed");
    await manager.close();
  });

  it("sends images through Pi prompt options", async () => {
    const session = new FakeSession();
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "", [], [{ mediaType: "image/png", data: "aW1hZ2U=" }]).result;

    expect(session.prompt).toHaveBeenCalledWith("", {
      images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    });
    await manager.close();
  });

  it("keeps image data out of replay events", async () => {
    const session = new FakeSession();
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const image = { mediaType: "image/png" as const, data: "aW1hZ2U=" };

    await manager.prompt(project, conversation, "Describe", [], [image]).result;

    expect(events.since(project.id).find((event) => event.type === "agent.started")?.data).toEqual({ prompt: "Describe" });
    expect(events.canReplay(project.id, 0)).toBe(false);
    await manager.close();
  });

  it("queues one follow-up for the active conversation", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const firstRun = manager.prompt(project, conversation, "First").result;
    expect(manager.state(conversation).agent.status).toBe("running");
    const queued = manager.prompt(project, conversation, "Second");
    await queued.result;
    expect(queued).toMatchObject({ queued: true, turnId: expect.any(String) });
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([
      expect.objectContaining({ prompt: "Second" }),
    ]);

    prompt.resolve();
    await expect(firstRun).resolves.toBe("completed");
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.followUp).toHaveBeenCalledWith("Second", undefined);
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([]);
    await manager.close();
  });

  it("keeps and removes multiple pending follow-ups", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const stale = manager.prompt(project, conversation, "Second");
    const replacement = manager.prompt(project, conversation, "Replacement", [{ type: "workspace-file", path: "src/app.ts" }]);
    await Promise.all([stale.result, replacement.result]);
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([
      expect.objectContaining({ prompt: "Second" }),
      expect.objectContaining({ prompt: "Replacement", references: [{ type: "workspace-file", path: "src/app.ts" }] }),
    ]);

    expect(await manager.removePending(project.id, conversation.summary.id, "stale-turn")).toBe(false);
    expect(await manager.removePending(project.id, conversation.summary.id, replacement.turnId)).toBe(true);
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([
      expect.objectContaining({ turnId: stale.turnId, prompt: "Second" }),
    ]);
    expect(events.since(project.id).at(-1)?.type).toBe("prompt.removed");
    prompt.resolve();
    await run;
    expect(session.prompt).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("steers and removes queued messages through Pi", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const second = manager.prompt(project, conversation, "Second");
    const third = manager.prompt(project, conversation, "Third");
    await Promise.all([second.result, third.result]);
    expect(session.followUp.mock.calls.map(([message]) => message)).toEqual(["Second", "Third"]);

    session.clearQueue.mockClear();
    session.followUp.mockClear();
    await manager.steerPending(project.id, conversation.summary.id, third.turnId);
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.steer).toHaveBeenLastCalledWith("Third", undefined);
    expect(session.followUp).toHaveBeenCalledWith("Second", undefined);
    expect(manager.pendingPrompts(project.id, conversation.summary.id).map(({ turnId }) => turnId)).toEqual([second.turnId]);

    session.steer.mockClear();
    await manager.removePending(project.id, conversation.summary.id, second.turnId);
    expect(session.steer).toHaveBeenCalledWith("Third", undefined);
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([]);

    prompt.resolve();
    await run;
    await manager.close();
  });

  it("keeps local queue state unchanged when Pi cannot replay a removal", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const second = manager.prompt(project, conversation, "Second");
    const third = manager.prompt(project, conversation, "Third");
    await Promise.all([second.result, third.result]);
    session.followUp.mockRejectedValueOnce(new Error("Queue unavailable"));

    await expect(manager.removePending(project.id, conversation.summary.id, second.turnId)).rejects.toThrow("Queue unavailable");
    expect(manager.pendingPrompts(project.id, conversation.summary.id).map(({ turnId }) => turnId)).toEqual([second.turnId, third.turnId]);

    prompt.resolve();
    await run;
    await manager.close();
  });

  it("clears Pi messages left behind when a run ends early", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const queued = manager.prompt(project, conversation, "Second");
    await queued.result;
    prompt.resolve();
    await run;

    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([]);
    await manager.close();
  });

  it("starts the queued UI turn when Pi begins an expanded user message", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const queued = manager.prompt(project, conversation, "Second");
    await queued.result;
    session.emit({ type: "message_start", message: { role: "user", content: "Expanded by Pi", timestamp: Date.now() } } as AgentSessionEvent);

    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([]);
    expect(manager.state(conversation).agent).toEqual({ status: "running", turnId: queued.turnId });
    expect(events.since(project.id).slice(-2)).toEqual([
      expect.objectContaining({ type: "prompt.removed", turnId: queued.turnId }),
      expect.objectContaining({ type: "agent.started", turnId: queued.turnId, data: { prompt: "Second" } }),
    ]);

    prompt.resolve();
    await run;
    await manager.close();
  });

  it("cleans up a follow-up that races with run completion", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    const followUpRelease = deferred<void>();
    const queuedInPi: string[] = [];
    session.prompt.mockImplementation(() => prompt.promise);
    session.followUp.mockImplementation(async (message) => {
      await followUpRelease.promise;
      queuedInPi.push(message);
    });
    session.clearQueue.mockImplementation(() => {
      queuedInPi.length = 0;
      return { steering: [], followUp: [] };
    });
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    const queued = manager.prompt(project, conversation, "Second");
    await vi.waitFor(() => expect(session.followUp).toHaveBeenCalledOnce());
    prompt.resolve();
    await Promise.resolve();
    followUpRelease.resolve();
    await Promise.all([run, queued.result]);

    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(queuedInPi).toEqual([]);
    expect(manager.pendingPrompts(project.id, conversation.summary.id)).toEqual([]);
    await manager.close();
  });

  it("runs conversations in the same project independently", async () => {
    const firstSession = new FakeSession();
    const secondSession = new FakeSession();
    const firstPrompt = deferred<void>();
    const secondPrompt = deferred<void>();
    firstSession.prompt.mockImplementation(() => firstPrompt.promise);
    secondSession.prompt.mockImplementation(() => secondPrompt.promise);
    const manager = new AgentManager(new RuntimeEventBus(), {
      createSession: async (_project, conversation) => conversation.summary.id === "conversation-1" ? firstSession : secondSession,
    });
    const project = createProject();
    const first = createConversation(project, "conversation-1");
    const second = createConversation(project, "conversation-2");

    const firstRun = manager.prompt(project, first, "First").result;
    const secondRun = manager.prompt(project, second, "Second").result;
    await vi.waitFor(() => {
      expect(firstSession.prompt).toHaveBeenCalledWith("First");
      expect(secondSession.prompt).toHaveBeenCalledWith("Second");
    });
    expect(manager.activeTurn(project.id, first.summary.id)).toMatchObject({ conversationId: first.summary.id });
    expect(manager.activeTurn(project.id, second.summary.id)).toMatchObject({ conversationId: second.summary.id });

    firstPrompt.resolve();
    await firstRun;
    expect(manager.activeTurn(project.id, first.summary.id)).toBeUndefined();
    expect(manager.activeTurn(project.id, second.summary.id)).toMatchObject({ conversationId: second.summary.id });
    expect(manager.isProjectBusy(project.id)).toBe(true);

    secondPrompt.resolve();
    await secondRun;
    expect(manager.isProjectBusy(project.id)).toBe(false);
    await manager.close();
  });

  it("cancels only the exact active conversation and turn", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    session.abort.mockImplementation(async () => prompt.resolve());
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const turn = manager.prompt(project, conversation, "Build");
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    await manager.cancel(project.id, "another-conversation", turn.turnId);
    await manager.cancel(project.id, conversation.summary.id, "another-turn");
    expect(session.abort).not.toHaveBeenCalled();

    await manager.cancel(project.id, conversation.summary.id, turn.turnId);
    await expect(turn.result).resolves.toBe("cancelled");
    expect(session.abort).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("surfaces session initialization failures", async () => {
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => { throw new Error("Auth unavailable"); } });
    const project = createProject();
    const conversation = createConversation(project);

    await expect(manager.prompt(project, conversation, "Build").result).rejects.toThrow("Auth unavailable");
    expect(manager.state(conversation).agent).toEqual({ status: "error", error: "Auth unavailable" });
    expect(events.since(project.id).at(-1)?.type).toBe("agent.error");
    await manager.close();
  });

  it("rejects when Pi resolves with an assistant error", async () => {
    const session = new FakeSession();
    session.messages.push({ role: "assistant", stopReason: "error", errorMessage: "No API key" });
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await expect(manager.prompt(project, conversation, "Build").result).rejects.toThrow("No API key");
    expect(manager.state(conversation).agent).toEqual({ status: "error", error: "No API key" });
    await manager.close();
  });

  it("aborts and waits for active work before closing", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    session.abort.mockImplementation(async () => prompt.resolve());
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const run = manager.prompt(project, conversation, "Build").result;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    await manager.close();
    await expect(run).resolves.toBe("cancelled");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.state(conversation).agent.status).toBe("idle");
    expect(events.since(project.id).at(-1)?.type).toBe("agent.cancelled");
  });

  it("publishes only normalized UI events", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} as never },
      });
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspecting", partial: {} as never },
      });
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Inspecting", partial: {} as never },
      });
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: {} as never },
      });
      session.emit({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello", partial: {} as never },
      });
      const completedContent = [
        { type: "thinking", thinking: "Inspecting" },
        { type: "text", text: "Hello" },
      ];
      session.emit(messageUpdate({
        type: "text_end",
        contentIndex: 1,
        content: "Hello",
        partial: assistantPartial(completedContent),
      }));
      session.emit({
        type: "message_end",
        message: { ...assistantPartial(completedContent), stopReason: "toolUse" },
      } as AgentSessionEvent);
      session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "fetch failed" });
      session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts", oldText: "private", newText: "source" } });
      session.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts" }, partialResult: { content: [{ type: "text", text: "working" }] } });
      session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", result: { content: [{ type: "text", text: "patched" }] }, isError: false });
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "Build").result;
    const published = events.since(project.id);
    expect(published.map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "agent.started", data: { prompt: "Build" } },
      { type: "assistant.thinking.started", data: { itemId: expect.any(String) } },
      { type: "assistant.thinking.delta", data: { itemId: expect.any(String), delta: "Inspecting" } },
      { type: "assistant.thinking.completed", data: { itemId: expect.any(String), text: "Inspecting" } },
      { type: "assistant.started", data: { itemId: expect.any(String) } },
      { type: "assistant.delta", data: { itemId: expect.any(String), delta: "Hello" } },
      { type: "assistant.completed", data: { itemId: expect.any(String), status: "complete", phase: "commentary" } },
      { type: "agent.retrying", data: { attempt: 1, maxAttempts: 3, delayMs: 2_000, error: "fetch failed" } },
      { type: "tool.started", data: { itemId: expect.any(String), toolCallId: "call-1", toolName: "edit", args: { path: "src/app.ts" } } },
      { type: "tool.updated", data: { itemId: expect.any(String), toolCallId: "call-1", output: "working" } },
      { type: "tool.completed", data: { itemId: expect.any(String), toolCallId: "call-1", toolName: "edit", isError: false, output: "patched" } },
      { type: "agent.completed", data: {} },
    ]);
    expect(published.every((event) => (
      event.conversationId === conversation.summary.id && typeof event.turnId === "string"
    ))).toBe(true);
    await manager.close();
  });

  it("tracks multiple assistant text blocks by Pi content index", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      session.emit(messageUpdate({ type: "text_start", contentIndex: 0, partial: assistantPartial([
        textBlock("", "commentary"),
      ]) }));
      session.emit(messageUpdate({ type: "text_delta", contentIndex: 0, delta: "First", partial: assistantPartial([
        textBlock("First", "commentary"),
      ]) }));
      session.emit(messageUpdate({ type: "text_end", contentIndex: 0, content: "First", partial: assistantPartial([
        textBlock("First", "commentary"),
      ]) }));
      session.emit(messageUpdate({ type: "text_start", contentIndex: 1, partial: assistantPartial([
        textBlock("First", "commentary"),
        textBlock("", "final_answer"),
      ]) }));
      session.emit(messageUpdate({ type: "text_delta", contentIndex: 1, delta: "Second", partial: assistantPartial([
        textBlock("First", "commentary"),
        textBlock("Second", "final_answer"),
      ]) }));
      session.emit(messageUpdate({ type: "text_end", contentIndex: 1, content: "Second", partial: assistantPartial([
        textBlock("First", "commentary"),
        textBlock("Second", "final_answer"),
      ]) }));
      session.emit({
        type: "message_end",
        message: assistantPartial([
          textBlock("First", "commentary"),
          textBlock("Second", "final_answer"),
        ]),
      } as AgentSessionEvent);
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "Build").result;

    const assistantEvents = events.since(project.id).filter((event) => event.type.startsWith("assistant."));
    const startedIds = assistantEvents
      .filter((event) => event.type === "assistant.started")
      .map((event) => event.data.itemId);
    expect(new Set(startedIds).size).toBe(2);
    expect(assistantEvents.filter((event) => event.type === "assistant.completed").map((event) => event.data)).toEqual([
      { itemId: startedIds[0], status: "complete", phase: "commentary" },
      { itemId: startedIds[1], status: "complete", phase: "final_answer" },
    ]);
    await manager.close();
  });

  it("shows tool preparation before execution without forwarding argument deltas", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      const partial = assistantPartial([{ type: "toolCall", id: "call-1", name: "write", arguments: {} }]);
      session.emit(messageUpdate({ type: "toolcall_start", contentIndex: 0, partial }));
      session.emit(messageUpdate({ type: "toolcall_delta", contentIndex: 0, delta: '{"content":"private"}', partial }));
      session.emit(messageUpdate({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/app.ts", content: "private" } },
        partial,
      }));
      session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args: { path: "src/app.ts", content: "private" } });
      session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "write", result: { content: [{ type: "text", text: "written" }] }, isError: false });
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "Build").result;
    expect(events.since(project.id).map(({ type, data }) => ({ type, data }))).toContainEqual({
      type: "tool.preparing",
      data: { itemId: expect.any(String), toolCallId: "call-1", toolName: "write" },
    });
    expect(events.since(project.id).map(({ type }) => type)).toEqual([
      "agent.started",
      "tool.preparing",
      "tool.preparing",
      "tool.started",
      "tool.completed",
      "agent.completed",
    ]);
    expect(events.since(project.id).some((event) => JSON.stringify(event).includes("private"))).toBe(false);
    await manager.close();
  });

  it("forwards Pi compaction lifecycle", async () => {
    const session = new FakeSession();
    session.prompt.mockImplementation(async () => {
      session.emit({ type: "compaction_start", reason: "threshold" });
      session.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
    });
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "Continue").result;

    expect(events.since(project.id).map((event) => event.type)).toEqual([
      "agent.started",
      "agent.compaction.started",
      "agent.compaction.completed",
      "agent.completed",
    ]);
    expect(events.since(project.id).find((event) => event.type === "agent.compaction.completed")?.data).toEqual({
      reason: "threshold",
      aborted: false,
      willRetry: false,
    });
    await manager.close();
  });

  it("runs manual compaction through the native Pi session API", async () => {
    const session = new FakeSession();
    session.compact.mockImplementation(async () => {
      session.emit({ type: "compaction_start", reason: "manual" });
      session.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false });
    });
    const events = new RuntimeEventBus();
    const onRunCompleted = vi.fn();
    const manager = new AgentManager(events, { createSession: async () => session, onRunCompleted });
    const project = createProject();
    const conversation = createConversation(project);

    const turn = await manager.compact(project, conversation, "Keep the API decisions");
    await turn.result;

    expect(session.compact).toHaveBeenCalledWith("Keep the API decisions");
    expect(events.since(project.id).map((event) => event.type)).toEqual([
      "agent.compaction.started",
      "agent.compaction.completed",
    ]);
    expect(onRunCompleted).not.toHaveBeenCalled();
    await manager.close();
  });

  it("reads context usage from the native Pi session", async () => {
    const session = new FakeSession();
    session.getContextUsage.mockReturnValue({ tokens: 74_000, contextWindow: 100_000, percent: 74 });
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();

    await expect(manager.contextUsage(project, createConversation(project))).resolves.toEqual({
      tokens: 74_000,
      contextWindow: 100_000,
      percent: 74,
    });
    await manager.close();
  });

  it("keeps a cached session for each conversation", async () => {
    const firstSession = new FakeSession();
    const secondSession = new FakeSession();
    const createSession = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession });
    const project = createProject();

    await manager.prompt(project, createConversation(project, "conversation-1"), "First").result;
    await manager.prompt(project, createConversation(project, "conversation-2"), "Second").result;

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(firstSession.dispose).not.toHaveBeenCalled();
    expect(secondSession.dispose).not.toHaveBeenCalled();
    await manager.close();
    expect(firstSession.dispose).toHaveBeenCalledOnce();
    expect(secondSession.dispose).toHaveBeenCalledOnce();
  });

  it("updates cached session tools without recreating the session", async () => {
    const session = new FakeSession();
    let enabled = false;
    const createSession = vi.fn(async () => session);
    const manager = new AgentManager(new RuntimeEventBus(), {
      createSession,
      activeToolNames: () => ["read", ...(enabled ? ["generate_image"] : [])],
    });
    const project = createProject();
    const conversation = createConversation(project);

    await manager.prompt(project, conversation, "First").result;
    enabled = true;
    await manager.prompt(project, conversation, "Second").result;

    expect(createSession).toHaveBeenCalledOnce();
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(1, ["read"]);
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(2, ["read", "generate_image"]);
    expect(session.dispose).not.toHaveBeenCalled();
    await manager.close();
  });

  it("plans with read-only tools and waits for approval before executing", async () => {
    const session = new FakeSession();
    const planning = deferred<void>();
    session.prompt.mockImplementationOnce(() => planning.promise).mockResolvedValue(undefined);
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, {
      createSession: async () => session,
      activeToolNames: (mode) => mode === "planning" ? ["read", "update_plan"] : ["read", "write", "edit", "bash", "update_plan"],
    });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "Plan a refactor", [], [], "planning").result;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    session.emit({
      type: "tool_execution_end",
      toolCallId: "plan-1",
      toolName: "update_plan",
      isError: false,
      result: { details: { plan: { steps: [{ step: "Inspect files", status: "in_progress" }] } } },
    });
    planning.resolve();
    await run;

    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(1, ["read", "update_plan"]);
    expect(manager.planState(conversation)).toEqual({
      mode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect files", status: "in_progress" }] },
    });
    await expect(manager.reviseLast(project, conversation, "Rewrite history", async (reference) => reference))
      .rejects.toThrow("Finish or cancel the current plan");

    await (await manager.approvePlan(project, conversation)).result;
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(2, ["read", "write", "edit", "bash", "update_plan"]);
    expect(manager.planState(conversation)).toEqual({ mode: "normal" });
    expect(session.prompt.mock.calls[1]?.[0]).toContain("Approved plan:");
    await manager.close();
  });

  it("loads the session before persisting a cancelled plan", async () => {
    const session = new FakeSession();
    const createSession = vi.fn(async () => session);
    const manager = new AgentManager(new RuntimeEventBus(), { createSession });
    const project = createProject();
    const conversation = createConversation(project);
    manager.restorePlanState(conversation, {
      mode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect files", status: "pending" }] },
    });

    await manager.cancelPlan(project, conversation);

    expect(createSession).toHaveBeenCalledOnce();
    expect(session.appendCustomEntry).toHaveBeenCalledWith("open-game-plan", { mode: "normal" });
    await manager.close();
  });

  it("forgets in-memory plan state with its project", async () => {
    const manager = new AgentManager(new RuntimeEventBus());
    const project = createProject();
    const conversation = createConversation(project);
    manager.restorePlanState(conversation, {
      mode: "awaiting_approval",
      plan: { steps: [{ step: "Inspect files", status: "pending" }] },
    });

    manager.forgetProject(project.id);

    expect(manager.planState(conversation)).toEqual({ mode: "normal" });
    await manager.close();
  });

  it("uses Pi to change the model of a cached session", async () => {
    const session = new FakeSession();
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const model = { provider: "openai-codex", id: "gpt-5.5" } as never;
    const persist = vi.fn();

    await manager.prompt(project, conversation, "First").result;
    await manager.setModel(project.id, conversation.summary.id, model, persist);

    expect(session.setModel).toHaveBeenCalledWith(model);
    expect(persist).not.toHaveBeenCalled();
    await manager.close();
  });

  it("uses Pi to change reasoning on a cached session", async () => {
    const session = new FakeSession();
    const manager = new AgentManager(new RuntimeEventBus(), { createSession: async () => session });
    const project = createProject();
    const conversation = createConversation(project);
    const persist = vi.fn();

    await manager.prompt(project, conversation, "First").result;
    const reasoning = await manager.setReasoningLevel(project.id, conversation.summary.id, "high", persist);

    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(reasoning).toBe("high");
    expect(persist).not.toHaveBeenCalled();
    await manager.close();
  });

  it("does not change tools during an active run", async () => {
    const session = new FakeSession();
    const prompt = deferred<void>();
    session.prompt.mockImplementation(() => prompt.promise);
    let enabled = false;
    const manager = new AgentManager(new RuntimeEventBus(), {
      createSession: async () => session,
      activeToolNames: () => ["read", ...(enabled ? ["generate_image"] : [])],
    });
    const project = createProject();
    const conversation = createConversation(project);

    const run = manager.prompt(project, conversation, "First").result;
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    enabled = true;
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);

    prompt.resolve();
    await run;
    session.prompt.mockResolvedValue();
    await manager.prompt(project, conversation, "Second").result;
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "generate_image"]);
    await manager.close();
  });

  it("revises the latest persisted user turn through Pi tree navigation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "open-game-revise-"));
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const stored = SessionManager.create(workspacePath, path.join(root, "session"));
    const userId = stored.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Original\n\n<workspace-file-references>\n[\"index.html\"]\n</workspace-file-references>" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      timestamp: Date.now(),
    });
    stored.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      api: "openai-responses",
      provider: "openai",
      model: "test",
      timestamp: Date.now(),
    });
    const project = { ...createProject(), workspacePath };
    const conversation = { ...createConversation(project), sessionPath: stored.getSessionFile()! };
    const session = new FakeSession();
    const events = new RuntimeEventBus();
    const manager = new AgentManager(events, { createSession: async () => session });

    const validation = deferred<{ type: "workspace-file"; path: string }>();
    const revisionPromise = manager.reviseLast(project, conversation, "Revised", () => validation.promise);
    await vi.waitFor(() => expect(manager.isProjectBusy(project.id)).toBe(true));
    await expect(manager.setModel(project.id, conversation.summary.id, { provider: "test", id: "test" } as never, vi.fn()))
      .rejects.toThrow("Wait for the agent to finish");
    validation.resolve({ type: "workspace-file", path: "index.html" });
    const revision = await revisionPromise;
    await revision.result;

    expect(session.navigateTree).toHaveBeenCalledWith(userId, { summarize: false });
    expect(session.prompt).toHaveBeenCalledWith(
      "Revised\n\n<workspace-file-references>\n[\"index.html\"]\n</workspace-file-references>",
      { images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] },
    );
    expect(events.since(project.id).find((event) => event.type === "agent.started")?.data).toMatchObject({
      prompt: "Revised",
      revision: "last-turn",
    });
    await manager.close();
  });
});

class FakeSession implements CodingSession {
  messages: unknown[] = [];
  thinkingLevel: AgentReasoningLevel = "medium";
  prompt = vi.fn<CodingSession["prompt"]>(async () => {});
  followUp = vi.fn<NonNullable<CodingSession["followUp"]>>(async () => {});
  steer = vi.fn<NonNullable<CodingSession["steer"]>>(async () => {});
  clearQueue = vi.fn<NonNullable<CodingSession["clearQueue"]>>(() => ({ steering: [], followUp: [] }));
  navigateTree = vi.fn<NonNullable<CodingSession["navigateTree"]>>(async () => ({ cancelled: false }));
  compact = vi.fn<NonNullable<CodingSession["compact"]>>(async () => {});
  getContextUsage = vi.fn<NonNullable<CodingSession["getContextUsage"]>>(() => undefined);
  abort = vi.fn<() => Promise<void>>(async () => {});
  dispose = vi.fn<() => void>();
  setModel = vi.fn<NonNullable<CodingSession["setModel"]>>(async () => {});
  setThinkingLevel = vi.fn<NonNullable<CodingSession["setThinkingLevel"]>>((level) => { this.thinkingLevel = level; });
  setActiveToolsByName = vi.fn<(toolNames: string[]) => void>();
  appendCustomEntry = vi.fn((customType: string, data: unknown) => {
    this.#entries.push({ type: "custom", customType, data });
    return `entry-${this.#entries.length}`;
  });
  sessionManager = {
    appendCustomEntry: this.appendCustomEntry,
    getBranch: () => this.#entries as never,
  };
  #entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  #listener?: (event: AgentSessionEvent) => void;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listener = listener;
    return () => { this.#listener = undefined; };
  }

  emit(event: AgentSessionEvent): void {
    this.#listener?.(event);
  }
}

function createProject(): ProjectState {
  return {
    id: "project-1",
    name: "Project",
    type: "general",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/project-1",
    preview: { status: "waiting" },
  };
}

function createConversation(project: ProjectState, id = "conversation-1"): StoredConversation {
  return {
    sessionPath: `/tmp/${id}.jsonl`,
    summary: {
      id,
      projectId: project.id,
      title: "Conversation",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sessionMessage(id: string, message: object): object {
  return { type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message };
}

function messageUpdate(assistantMessageEvent: object): AgentSessionEvent {
  return {
    type: "message_update",
    message: assistantPartial([]),
    assistantMessageEvent,
  } as AgentSessionEvent;
}

function assistantPartial(content: object[]) {
  return {
    role: "assistant" as const,
    content,
    stopReason: "stop" as const,
  };
}

function textBlock(text: string, phase: "commentary" | "final_answer"): object {
  return {
    type: "text",
    text,
    textSignature: JSON.stringify({ v: 1, id: `${phase}-id`, phase }),
  };
}
