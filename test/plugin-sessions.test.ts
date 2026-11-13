import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSessions } from "../src/daemon/plugin-sessions.js";
import { AgentManager, type CodingSession } from "../src/daemon/agent.js";
import { ConversationManager } from "../src/daemon/conversations.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type {
  PluginSessionRequest,
  PluginSessionResults,
} from "../src/shared/plugin-sessions.js";

describe("native session service", () => {
  let root: string;
  let project: ProjectState;
  let conversations: ConversationManager;
  let agents: AgentManager;
  let events: RuntimeEventBus;
  let service: PluginSessions;
  let finish: () => void;
  let abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let prompt: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let prepare: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const authorize = vi.fn(async () => {});
  const call = <R extends PluginSessionRequest>(
    request: R,
    signal = new AbortController().signal,
  ) =>
    service.handle("acme/messenger", request, signal, authorize) as Promise<
      PluginSessionResults[R["operation"]]
    >;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ohmygame-session-api-"));
    project = {
      id: "project",
      name: "Game",
      type: "web-game",
      workspacePath: root,
      updatedAt: new Date().toISOString(),
      preview: { status: "waiting" },
    };
    conversations = new ConversationManager();
    events = new RuntimeEventBus(3);
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    abort = vi.fn(async () => finish());
    prompt = vi.fn(async () => pending);
    const session: CodingSession = {
      messages: [],
      prompt,
      abort,
      dispose() {},
      subscribe: () => () => {},
    };
    agents = new AgentManager(events, { createSession: async () => session });
    prepare = vi.fn(async () => {});
    authorize.mockReset().mockResolvedValue();
    service = new PluginSessions({
      projects: {
        list: () => [project],
        get: (id) => (id === project.id ? project : undefined),
      },
      conversations,
      agents,
      events,
      prepare,
      sent() {},
    });
  });
  afterEach(async () => {
    finish();
    await agents.close();
    await rm(root, { recursive: true, force: true });
  });

  it("lists and creates conversations, accepts one attributed turn, leaves approvals to the user and stops explicitly", async () => {
    expect(await call({ operation: "projects" })).toEqual({
      projects: [{ id: "project", name: "Game" }],
      truncated: false,
    });
    const { id } = await call({ operation: "create", projectId: project.id });
    const target = { projectId: project.id, conversationId: id };
    expect(
      (await call({ operation: "conversations", projectId: project.id }))
        .conversations[0]?.id,
    ).toBe(id);
    const controller = new AbortController();
    const turn = await call(
      { operation: "send", ...target, text: "Build" },
      controller.signal,
    );
    controller.abort();
    expect(agents.activeTurnId(project.id, id)).toBe(turn.turnId);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(abort).not.toHaveBeenCalled();
    await expect(
      call({ operation: "send", ...target, text: "Repeat" }),
    ).rejects.toThrow("busy");
    const approval = agents.askApproval(project.id, id, "write", {
      title: "Write",
      description: "Change a file",
    } as never);
    expect(await call({ operation: "read", ...target })).toMatchObject({
      status: "running",
      needsApproval: true,
      messages: [{ text: "Build", source: { plugin: "acme/messenger" } }],
    });
    await expect(
      call({ operation: "approve", ...target } as never),
    ).rejects.toThrow("Unknown");
    expect(await call({ operation: "stop", ...target })).toEqual({
      stopped: true,
    });
    await expect(approval).resolves.toBe("deny");
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each(["error", "aborted"] as const)(
    "recovers the %s outcome from history after events are gone",
    async (stopReason) => {
      const { id } = await call({ operation: "create", projectId: project.id });
      vi.spyOn(conversations, "view").mockResolvedValue({
        getBranch: () => [
          {
            type: "message",
            id: "response",
            parentId: null,
            timestamp: new Date(0).toISOString(),
            message: {
              role: "assistant",
              content: [],
              stopReason,
              ...(stopReason === "error" ? { errorMessage: "No API key" } : {}),
            },
          },
        ],
      } as never);
      const result = await call({
        operation: "read",
        projectId: project.id,
        conversationId: id,
      });
      expect(result.messages).toEqual([
        expect.objectContaining({
          role: "assistant",
          text: "",
          status: stopReason === "error" ? "failed" : "cancelled",
        }),
      ]);
      if (stopReason === "error")
        expect(result.messages[0]?.error).toEqual({
          code: "model_not_configured",
          message: "No API key",
        });
    },
  );

  it("rechecks consent after asynchronous preparation and rejects plans", async () => {
    const { id } = await call({ operation: "create", projectId: project.id });
    const target = { projectId: project.id, conversationId: id };
    prepare.mockImplementation(async () => {
      authorize.mockRejectedValue(new Error("Revoked"));
    });
    await expect(
      call({ operation: "send", ...target, text: "Denied" }),
    ).rejects.toThrow("Revoked");
    expect(agents.activeTurnId(project.id, id)).toBeUndefined();
    authorize.mockResolvedValue();
    const conversation = (await conversations.get(project, id))!;
    (await conversations.view(project, conversation)).appendCustomEntry(
      "ohmygame-plan",
      {
        mode: "awaiting_approval",
        plan: { steps: [{ step: "Build", status: "pending" }] },
      },
    );
    // A fresh agent manager models a daemon restart with a persisted plan.
    await agents.close();
    agents = new AgentManager(events);
    service = new PluginSessions({
      projects: { list: () => [project], get: () => project },
      conversations,
      agents,
      events,
      prepare,
      sent() {},
    });
    await expect(
      call({ operation: "send", ...target, text: "No bypass" }),
    ).rejects.toThrow("plan");
  });

  it("waits without losing events, resets expired or restarted cursors and cancels waiters", async () => {
    const baseline = await call({ operation: "events", projectId: project.id });
    const waiting = call({
      operation: "events",
      projectId: project.id,
      after: baseline.cursor,
      waitMs: 1_000,
    });
    events.publish(
      project.id,
      "agent.completed",
      {},
      { conversationId: "conversation", turnId: "turn" },
    );
    const result = await waiting;
    expect(result).toMatchObject({
      reset: false,
      events: [
        {
          type: "agent.completed",
          conversationId: "conversation",
          turnId: "turn",
        },
      ],
    });
    for (let i = 0; i < 4; i++)
      events.publish(project.id, "agent.completed", {});
    expect(
      await call({
        operation: "events",
        projectId: project.id,
        after: baseline.cursor,
      }),
    ).toMatchObject({ reset: true });
    expect(
      await call({
        operation: "events",
        projectId: project.id,
        after: "previous-daemon:1",
      }),
    ).toMatchObject({ reset: true });
    const current = await call({ operation: "events", projectId: project.id });
    const controller = new AbortController();
    const cancelled = call(
      {
        operation: "events",
        projectId: project.id,
        after: current.cursor,
        waitMs: 25_000,
      },
      controller.signal,
    );
    controller.abort(new Error("Disconnected"));
    await expect(cancelled).rejects.toThrow("Disconnected");
    expect(
      await call({
        operation: "events",
        projectId: project.id,
        after: current.cursor,
      }),
    ).toMatchObject({ reset: false, events: [] });
  });

  it.each([
    { operation: "send", projectId: "project", conversationId: "c", text: " " },
    {
      operation: "send",
      projectId: "project",
      conversationId: "c",
      text: "a".repeat(32_001),
    },
    {
      operation: "send",
      projectId: "project",
      conversationId: "c",
      text: "hi",
      source: { plugin: "forged" },
    },
    { operation: "events", projectId: "project", waitMs: -1 },
    { operation: "events", projectId: "project", waitMs: 25_001 },
    { operation: "read", projectId: "../project", conversationId: "c" },
    { operation: "constructor" },
  ])("rejects invalid or privileged request fields", async (request) => {
    await expect(call(request as PluginSessionRequest)).rejects.toThrow();
  });
});
