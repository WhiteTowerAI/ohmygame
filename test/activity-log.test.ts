import { describe, expect, it } from "vitest";
import { ActivityLog } from "../src/daemon/activity-log.js";
import { RuntimeEventBus } from "../src/shared/events.js";

function setup() {
  const lines: {
    level: string;
    message: string;
    details: Record<string, unknown>;
  }[] = [];
  let time = 1_000;
  const activity = new ActivityLog(
    {
      info: (details, message) =>
        lines.push({
          level: "info",
          message,
          details: details as Record<string, unknown>,
        }),
      warn: (details, message) =>
        lines.push({
          level: "warn",
          message,
          details: details as Record<string, unknown>,
        }),
    },
    () => time,
  );
  const events = new RuntimeEventBus();
  events.subscribeAll((event) => activity.event(event));
  return {
    lines,
    events,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const scope = { conversationId: "c1", turnId: "t1" };

describe("activity log", () => {
  it("redacts credentials before selecting tool and preview output tails", () => {
    const { lines, events } = setup();
    events.publish(
      "p1",
      "item.completed",
      {
        item: {
          id: "tool",
          turnId: "t1",
          type: "dynamicToolCall",
          toolCallId: "call",
          tool: "bash",
          status: "failed",
          arguments: {},
          output: `api_key=msy_fixture_tail_secret\n${"x".repeat(476)}`,
        },
      },
      scope,
    );
    events.publish("p1", "preview.updated", {
      preview: {
        status: "error",
        error: "The dev server exited (1)",
        logs: `api_key=msy_fixture_preview_secret\n${"x".repeat(1_973)}`,
      },
    });
    expect(JSON.stringify(lines)).not.toContain("fixture");
    expect(lines[0]!.details.error).toContain("api_key=[redacted]");
    expect(lines[1]!.details.output).toContain("[redacted]");
  });
  it("records agent turns with their duration and never the prompt", () => {
    const { lines, events, advance } = setup();

    events.publish(
      "p1",
      "agent.started",
      { prompt: "Make a secret dungeon", images: [{ id: "i1" } as never] },
      scope,
    );
    advance(2_500);
    events.publish("p1", "agent.completed", {}, scope);
    events.publish("p2", "agent.started", { prompt: "Another" }, scope);
    advance(100);
    events.publish("p2", "agent.error", { error: "Rate limit reached" }, scope);

    expect(lines).toEqual([
      {
        level: "info",
        message: "Agent turn started",
        details: {
          projectId: "p1",
          ...scope,
          images: 1,
          attachments: 0,
          plugins: [],
        },
      },
      {
        level: "info",
        message: "Agent turn completed",
        details: { projectId: "p1", ...scope, durationMs: 2_500 },
      },
      {
        level: "info",
        message: "Agent turn started",
        details: {
          projectId: "p2",
          ...scope,
          images: 0,
          attachments: 0,
          plugins: [],
        },
      },
      {
        level: "warn",
        message: "Agent turn failed",
        details: {
          projectId: "p2",
          ...scope,
          durationMs: 100,
          error: "Rate limit reached",
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret dungeon");
  });

  it("records failed tools and retries, but not their input or successful output", () => {
    const { lines, events } = setup();

    events.publish(
      "p1",
      "item.completed",
      {
        item: {
          id: "a",
          turnId: "t1",
          type: "dynamicToolCall",
          toolCallId: "x",
          tool: "bash",
          status: "completed",
          arguments: { command: "ls" },
          output: "game.ts",
        },
      },
      scope,
    );
    events.publish(
      "p1",
      "item.completed",
      {
        item: {
          id: "b",
          turnId: "t1",
          type: "mcpToolCall",
          toolCallId: "y",
          server: "godot",
          tool: "run_project",
          status: "failed",
          arguments: { path: "x" },
          output: "Godot was not found",
        },
      },
      scope,
    );
    events.publish(
      "p1",
      "item.started",
      {
        item: {
          id: "c",
          turnId: "t1",
          type: "retry",
          status: "inProgress",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 4_000,
          error: { message: "Overloaded", code: "rate_limit" },
        } as never,
      },
      scope,
    );

    expect(lines).toEqual([
      {
        level: "warn",
        message: "Agent tool failed",
        details: {
          projectId: "p1",
          ...scope,
          tool: "run_project",
          server: "godot",
          error: "Godot was not found",
        },
      },
      {
        level: "warn",
        message: "Model request will be retried",
        details: {
          projectId: "p1",
          ...scope,
          attempt: 2,
          maxAttempts: 3,
          delayMs: 4_000,
          code: "rate_limit",
          error: "Overloaded",
        },
      },
    ]);
  });

  it("keeps only the end of a failed tool's output", () => {
    const { lines, events } = setup();

    events.publish(
      "p1",
      "item.completed",
      {
        item: {
          id: "a",
          turnId: "t1",
          type: "dynamicToolCall",
          toolCallId: "x",
          tool: "bash",
          status: "failed",
          output: `${"const secret = 1;\n".repeat(100)}Command exited with code 1`,
        },
      },
      scope,
    );

    expect(lines[0]!.details.error).toHaveLength(500);
    expect(lines[0]!.details.error).toMatch(/Command exited with code 1$/);
  });

  it("records preview status changes and the end of a failed preview's output", () => {
    const { lines, events } = setup();
    const output = `${"x".repeat(5_000)}Error: Cannot find module 'vite'`;

    events.publish("p1", "preview.updated", {
      preview: {
        status: "starting",
        phase: "installing",
        manager: "npm",
        command: "npm run dev",
      },
    });
    events.publish("p1", "preview.updated", {
      preview: {
        status: "starting",
        phase: "launching",
        manager: "npm",
        command: "npm run dev",
      },
    });
    events.publish("p1", "preview.updated", {
      preview: {
        status: "error",
        phase: "launching",
        manager: "npm",
        command: "npm run dev",
        error: "The dev server exited (1)",
        logs: output,
      },
    });

    expect(lines.map(({ message }) => message)).toEqual([
      "Preview starting",
      "Preview failed",
    ]);
    expect(lines[1]!.details).toMatchObject({
      projectId: "p1",
      status: "error",
      phase: "launching",
      error: "The dev server exited (1)",
    });
    expect(lines[1]!.details.output).toHaveLength(2_000);
    expect(lines[1]!.details.output).toMatch(/Cannot find module 'vite'$/);
  });

  it("records model changes", () => {
    const { lines, events } = setup();

    events.publish(
      "p1",
      "conversation.model.changed",
      {
        item: {
          id: "m",
          turnId: "t1",
          type: "modelChange",
          model: { provider: "google", id: "gemini-2.5-flash-lite" },
        },
      },
      scope,
    );

    expect(lines).toEqual([
      {
        level: "info",
        message: "Conversation model changed",
        details: {
          projectId: "p1",
          ...scope,
          model: "google/gemini-2.5-flash-lite",
        },
      },
    ]);
  });

  it("records publishing", () => {
    const { lines, events } = setup();

    events.publish("p1", "publish.started", {});
    events.publish("p1", "publish.error", {
      error: "The build has no index.html",
    });

    expect(lines).toEqual([
      {
        level: "info",
        message: "Publish started",
        details: { projectId: "p1" },
      },
      {
        level: "warn",
        message: "Publish failed",
        details: { projectId: "p1", error: "The build has no index.html" },
      },
    ]);
  });

  it("records a failed turn once with duration and model diagnostics", () => {
    const { lines, events, advance } = setup();
    events.publish("p1", "agent.started", { prompt: "Private prompt" }, scope);
    advance(200);
    const diagnostics = {
      provider: "deepseek",
      model: "deepseek-chat",
      statusCode: 429,
      retryAttempts: 2,
    };
    events.publish(
      "p1",
      "agent.error",
      { error: "Rate limit", code: "rate_limited", diagnostics },
      scope,
    );
    expect(lines.filter(({ level }) => level === "warn")).toEqual([
      {
        level: "warn",
        message: "Agent turn failed",
        details: {
          projectId: "p1",
          ...scope,
          durationMs: 200,
          error: "Rate limit",
          code: "rate_limited",
          diagnostics,
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Private prompt");
  });

  it("never lets a logging failure reach the code that published the event", () => {
    const failing = new ActivityLog({
      info: () => {
        throw new Error("The log stream is closed");
      },
      warn: () => {
        throw new Error("The log stream is closed");
      },
    });
    const events = new RuntimeEventBus();
    events.subscribeAll((event) => failing.event(event));

    expect(() =>
      events.publish("p1", "agent.started", { prompt: "Hi" }, scope),
    ).not.toThrow();
    expect(() =>
      events.publish("p1", "preview.updated", {
        preview: { status: "error", logs: 42 as never },
      }),
    ).not.toThrow();
  });
});
