import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ThreadItem, Turn } from "../src/shared/contracts.js";

// Inspect the expanded contents in presentation tests. Mount behavior is tested separately.
const lazyDetailsPath = fileURLToPath(new URL("../src/renderer/lazy-details.tsx", import.meta.url));
vi.doMock(lazyDetailsPath, () => ({
  LazyDetails: ({ className, summary, children }: { className: string; summary: React.ReactNode; children: React.ReactNode }) =>
    <details className={className}>{summary}{children}</details>,
}));

const { AgentTimeline: ThreadTimeline } = await import("../src/renderer/agent-timeline.js");

it("does not mount the contents of a collapsed detail", async () => {
  const { LazyDetails: ActualDetails } = await vi.importActual<typeof import("../src/renderer/lazy-details.js")>(lazyDetailsPath);
  const html = renderToStaticMarkup(<ActualDetails className="test-details" summary={<summary>Inspect</summary>}>
    <div>Expensive content</div>
  </ActualDetails>);
  expect(html).toContain("Inspect");
  expect(html).not.toContain("Expensive content");
});

function AgentTimeline({ items, activeTurnId, failedTurnId, cancelledTurnId, ...props }: Omit<ComponentProps<typeof ThreadTimeline>, "turns"> & { items: ThreadItem[]; activeTurnId?: string; failedTurnId?: string; cancelledTurnId?: string }) {
  const grouped = new Map<string, ThreadItem[]>();
  for (const item of items) grouped.set(item.turnId, [...(grouped.get(item.turnId) ?? []), item]);
  const turns: Turn[] = [...grouped].map(([id, turnItems]) => ({
    id,
    conversationId: "conversation-1",
    status: id === activeTurnId ? "inProgress" : id === failedTurnId ? "failed" : id === cancelledTurnId ? "cancelled" : "completed",
    items: turnItems,
  }));
  return <ThreadTimeline {...props} turns={turns} />;
}

describe("AgentTimeline", () => {
  it("does not render structured plans in conversation history", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "turn-1:plan", turnId: "turn-1", type: "plan", plan: { steps: [{ step: "Inspect files", status: "completed" }] } },
    ]} />);

    expect(html).not.toContain("Inspect files");
    expect(html).not.toContain("Worked for");
  });

  it("shows initial Thinking in the stable activity header", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user()]} activeTurnId="turn-1" />,
    );

    expect(html).toContain("Thinking");
    expect(html).toContain("work-summary-thinking");
    expect(html).toContain("work-activity-active");
    expect(html).not.toContain("Working for");
    expect(html).not.toContain("Worked");
    expect(html).not.toContain("<details");
  });

  it("hides streamed reasoning text behind the generic Thinking state", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "**Planning Vite app creation**", status: "inProgress" },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain('<span class="activity-shimmer">Thinking<span class="activity-shimmer-highlight" aria-hidden="true">Thinking</span></span>');
    expect(html).not.toContain("Planning Vite app creation");
  });

  it("keeps completed tools visible when work begins", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user(), tool()]} activeTurnId="turn-1" />,
    );

    expect(html).toContain("Working for");
    expect(html.match(/<div class="work-summary work-summary-active">([\s\S]*?)<\/div>/)?.[1]).not.toContain("solar-refresh-linear");
    expect(html).toContain("Thinking");
    expect(html).toContain("Read package.json");
    expect(html).toContain('class="tool-activity-group"');
    expect(html).toContain('<span class="tool-label activity-shimmer" title="Thinking" role="status">Thinking<span class="activity-shimmer-highlight" aria-hidden="true">Thinking</span></span>');
    expect(html).toContain('<summary class="tool-group-summary tool-group-summary-thinking"><span class="tool-label activity-shimmer"');
    expect(html).not.toContain('class="thinking-activity"');
    expect(html).not.toContain('class="tool-activity-group" open');
    expect(html).not.toContain("<details class=\"work-activity\"");
  });

  it("shimmers the initial Thinking header without a loading icon", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user()]} activeTurnId="turn-1" />);

    expect(html).toContain('<span class="activity-shimmer">Thinking<span class="activity-shimmer-highlight" aria-hidden="true">Thinking</span></span>');
    expect(html).not.toContain("solar-refresh-linear spin");
  });

  it("uses Working while streaming a direct answer but does not retain Worked after completion", () => {
    const streaming = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...assistant("response", "Hello"), status: "inProgress", phase: undefined },
    ]} activeTurnId="turn-1" />);
    const complete = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("response", "Hello", "final_answer"),
    ]} />);

    expect(streaming).toContain("Hello");
    expect(streaming).not.toContain("Thinking");
    expect(streaming).toContain("Working for");
    expect(complete).toContain("Hello");
    expect(complete).not.toContain("Worked");
  });

  it("shows Thinking while the next model step is pending after commentary", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      assistant("commentary", "I will write the game files.", "commentary"),
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("I will write the game files.");
    expect(html).toContain("Thinking");
    expect(html.indexOf("I will write the game files.")).toBeLessThan(html.lastIndexOf("Thinking"));
    expect(html.indexOf("Thinking")).toBeLessThan(html.indexOf('</div></section>'));
  });

  it("does not add Thinking while commentary is still streaming", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      { ...assistant("commentary", "I will write the game files."), status: "inProgress", phase: undefined },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("I will write the game files.");
    expect(html).not.toContain("thinking-activity");
  });

  it("shows Thinking after stalled text", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...assistant("commentary", "I will write the game files."), status: "inProgress", phase: undefined, timestamp: 1 },
    ]} activeTurnId="turn-1" />);

    expect(html.indexOf("I will write the game files.")).toBeLessThan(html.indexOf("Thinking"));
  });

  it("keeps unclassified text in the stable Working container until its phase is known", () => {
    const streaming = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...assistant("commentary", "I will inspect it."), status: "inProgress", phase: undefined },
    ]} activeTurnId="turn-1" />);
    const commentary = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
    ]} activeTurnId="turn-1" />);

    expect(streaming).not.toContain("Thinking");
    expect(streaming).toContain("Working for");
    expect(commentary.indexOf("Working for")).toBeLessThan(commentary.indexOf("I will inspect it."));
    expect(commentary).toContain("Thinking");
  });

  it("keeps completed and failed tools visible while waiting for the next step", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      {
        id: "failed-tool",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "failed-tool",
        tool: "bash",
        status: "failed",
        arguments: { command: "npm run build" },
        output: "private build output",
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Thinking");
    expect(html).not.toContain("Read a file, one action failed");
    expect(html).toContain("Ran npm run build");
    expect(html).not.toContain('class="tool-activity-details" open');
    expect(html).toContain("private build output");
  });

  it("does not keep completed Pi thinking as a history row", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "Inspect the project structure.", status: "completed" },
    ]} />);

    expect(html).not.toContain("Thinking");
    expect(html).not.toContain("Inspect the project structure.");
    expect(html).not.toContain("<details");
  });

  it("does not create empty Worked activity for Thinking followed by a final answer", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "private", status: "completed" },
      assistant("response", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Done.");
    expect(html).not.toContain("Thinking");
    expect(html).not.toContain("Worked for");
    expect(html).not.toContain("work-items");
  });

  it("describes an early stopped turn without exposing its reasoning text", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      { ...user(), timestamp: 1_000 },
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "private reasoning", status: "completed", timestamp: 2_000 },
      { id: "stopped", turnId: "turn-1", type: "agentMessage", text: "", status: "cancelled", timestamp: 4_000 },
    ]} cancelledTurnId="turn-1" />);

    expect(html).toContain("You stopped after 3s");
    expect(html).toContain("Stopped while thinking");
    expect(html).toContain('class="work-activity work-activity-stopped"');
    expect(html).not.toContain('<details class="work-activity"');
    expect(html).not.toContain("private reasoning");
    expect(html).not.toContain('<span class="muted-text">Stopped</span>');
  });

  it("keeps completed work inside a stopped turn", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      { ...user(), timestamp: 1_000 },
      { ...tool(), timestamp: 2_000 },
      { id: "stopped", turnId: "turn-1", type: "agentMessage", text: "", status: "cancelled", timestamp: 4_000 },
    ]} cancelledTurnId="turn-1" />);

    expect(html).toContain("You stopped after 3s");
    expect(html).toContain("Read a file");
    expect(html).toContain("Read package.json");
    expect(html).toContain('class="work-activity work-activity-stopped"');
    expect(html).not.toContain('<details class="work-activity"');
    expect(html).not.toContain("Stopped while thinking");
  });

  it("shows zero seconds when a turn is stopped in under a second", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      { ...user(), timestamp: 1_000 },
      { id: "stopped", turnId: "turn-1", type: "agentMessage", text: "", status: "cancelled", timestamp: 1_500 },
    ]} cancelledTurnId="turn-1" />);

    expect(html).toContain("You stopped after 0s");
    expect(html).not.toContain("&lt;1s");
  });

  it("keeps the latest tool before Thinking after earlier commentary", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "private", status: "completed" },
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Working for");
    expect(html).not.toContain("thinking-block");
    expect(html).toContain("I will inspect it.");
    expect(html).toContain("Thinking");
    expect(html).toContain("Read package.json");
  });

  it("omits completed Thinking while preserving the surrounding event order", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "private", status: "completed" },
      assistant("next", "I will update it.", "commentary"),
    ]} activeTurnId="turn-1" />);

    expect(html.indexOf("I will inspect it.")).toBeLessThan(html.indexOf("Read package.json"));
    expect(html.indexOf("Read package.json")).toBeLessThan(html.indexOf("I will update it."));
    expect(html).toContain("Thinking");
  });

  it("shows the current tools and Thinking together", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "Planning the next edit", status: "inProgress" },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Working for");
    expect(html).toContain("Thinking");
    expect(html).not.toContain("Planning the next edit");
    expect(html).toContain("package.json");
    expect(html).toContain("tool-activity-group");
    expect(html).toContain('<span class="tool-label activity-shimmer" title="Thinking" role="status">Thinking<span class="activity-shimmer-highlight" aria-hidden="true">Thinking</span></span>');
    expect(html).toContain('<summary class="tool-group-summary tool-group-summary-thinking"><span class="tool-label activity-shimmer"');
    expect(html).not.toContain('class="thinking-activity"');
  });

  it("restores the tool summary before rendering subsequent text", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      { ...assistant("commentary", "I found the relevant file."), status: "inProgress", phase: undefined },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Read a file");
    expect(html.indexOf("Read a file")).toBeLessThan(html.indexOf("I found the relevant file."));
    expect(html).not.toContain('title="Thinking">Thinking</span>');
  });

  it("keeps tools when completed reasoning returns to the generic status", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "Planning the next edit", status: "completed" },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Thinking");
    expect(html).not.toContain("Planning the next edit");
    expect(html).toContain("Read package.json");
  });

  it("drops Thinking from the final tool aggregation", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "private", status: "completed" },
      assistant("response", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Read package.json");
    expect(html).toContain("Read a file");
    expect(html).toContain("tool-activity-group");
    expect(html).not.toContain("Thinking");
  });

  it("groups Codex commentary and tools while keeping the final answer outside", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
      assistant("response", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Worked for");
    expect(html.indexOf("I will inspect it.")).toBeLessThan(html.indexOf("Read package.json"));
    expect(html.indexOf("Read package.json")).toBeLessThan(html.indexOf("Done."));
    expect(html.indexOf('class="work-items"')).toBeLessThan(html.indexOf("I will inspect it."));
    expect(html.indexOf("Done.")).toBeGreaterThan(html.indexOf("</details>"));
  });

  it("shows a right-facing arrow for collapsed Worked", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      assistant("response", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("solar-alt-arrow-right-linear work-chevron");
  });

  it("renders a failed stream as a connection activity inside Worked", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "assistant-error",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I started checking the project.",
      status: "failed",
      error: { message: "OpenAI Responses stream ended before a terminal response event" },
    }]} failedTurnId="turn-1" />);

    expect(html).toContain("Worked for");
    expect(html).toContain("I started checking the project.");
    expect(html).toContain("Connection error");
    expect(html).toContain("OpenAI Responses stream ended before a terminal response event");
    expect(html).toContain('class="connection-activity-details connection-activity-failed"');
    expect(html).toContain('class="work-activity work-activity-failed"');
    expect(html).not.toContain('<details class="work-activity"');
    expect(html).not.toContain('class="message-error"');
  });

  it("replaces missing model credentials with an actionable setup message", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "assistant-error",
      turnId: "turn-1",
      type: "agentMessage",
      text: "",
      status: "failed",
      error: { code: "model_not_configured", message: "No API key found for the selected model. Use /login to log into a provider via OAuth or API key. See: /local/path/providers.md" },
    }]} failedTurnId="turn-1" />);

    expect(html).toContain("Model setup required");
    expect(html).toContain("Choose an available model or connect its provider in Settings");
    expect(html).not.toContain("No API key");
    expect(html).not.toContain("/local/path/providers.md");
  });

  it("renders only the final connection error when a turn has multiple failed attempts", () => {
    const failedMessage = (id: string, text: string, error: string): ThreadItem => ({
      id,
      turnId: "turn-1",
      type: "agentMessage",
      text,
      status: "failed",
      error: { message: error },
    });
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      failedMessage("attempt-1", "First partial response.", "first disconnect"),
      failedMessage("attempt-2", "Second partial response.", "second disconnect"),
      failedMessage("attempt-3", "Third partial response.", "final disconnect"),
    ]} failedTurnId="turn-1" />);

    expect(html.match(/Connection error/g)).toHaveLength(1);
    expect(html).not.toContain("first disconnect");
    expect(html).not.toContain("second disconnect");
    expect(html).toContain("final disconnect");
    expect(html.indexOf("Third partial response.")).toBeLessThan(html.indexOf("Connection error"));
  });

  it("shows only one expandable reconnect row for a retried stream error", () => {
    const error = "OpenAI Responses stream ended before a terminal response event";
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "assistant-error",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I started checking the project.",
      status: "failed",
      error: { message: error },
    }, {
      id: "retry",
      turnId: "turn-1",
      type: "retry",
      status: "inProgress",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1_000,
      error: { message: error },
    }]} activeTurnId="turn-1" />);

    expect(html).toContain("Reconnecting 1/3");
    expect(html.match(/OpenAI Responses stream ended before a terminal response event/g)).toHaveLength(1);
    expect(html.match(/connection-activity-details/g)).toHaveLength(1);
    expect(html).toContain("tool-detail-chevron");
    expect(html).not.toContain("solar-refresh-linear spin");
    expect(html).not.toContain("activity-shimmer");
  });

  it("keeps reconnecting static after later activity appears", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "retry",
      turnId: "turn-1",
      type: "retry",
      status: "inProgress",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1_000,
      error: { message: "stream disconnected" },
    }, assistant("commentary", "I resumed the work.", "commentary")]} activeTurnId="turn-1" />);

    expect(html).toContain("Reconnecting 1/3");
    expect(html).toContain('Reconnecting 1/3</span><svg');
    expect(html).toContain('<span class="tool-label">Reconnecting 1/3</span>');
    expect(html).not.toContain("solar-refresh-linear spin");
    expect(html).not.toContain('class="tool-label activity-shimmer">Reconnecting');
  });

  it("does not present an intermediate stream failure as a final connection error", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "assistant-error",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I started checking the project.",
      status: "failed",
      error: { message: "stream disconnected" },
    }]} activeTurnId="turn-1" />);

    expect(html).toContain("I started checking the project.");
    expect(html).not.toContain("Connection error");
  });

  it("does not render an empty failed message between tool groups", () => {
    const failedTool = (id: string): ThreadItem => ({
      ...tool(),
      id,
      toolCallId: id,
      status: "failed",
    });
    const writtenFile = (id: string, path: string): ThreadItem => ({
      ...tool(),
      id,
      toolCallId: id,
      tool: "write",
      arguments: { path },
    });
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      failedTool("failed-tool-1"),
      failedTool("failed-tool-2"),
      {
        id: "assistant-error",
        turnId: "turn-1",
        type: "agentMessage",
        text: "",
        status: "failed",
        error: { message: "stream disconnected" },
      },
      writtenFile("write-1", "one.ts"),
      writtenFile("write-2", "two.ts"),
      writtenFile("write-3", "three.ts"),
    ]} />);

    expect(html).toContain("Actions failed");
    expect(html).toContain("Edited files");
    expect(html).not.toContain("2 actions failed");
    expect(html).not.toContain("Edited 3 files");
    expect(html.match(/class="tool-activity-group"/g)).toHaveLength(2);
    expect(html).not.toContain("assistant-failed");
    expect(html).not.toContain("stream disconnected");
  });

  it("does not show a retry after reconnection succeeds", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "retry",
      turnId: "turn-1",
      type: "retry",
      status: "completed",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1_000,
      error: { message: "stream disconnected" },
    }, assistant("response", "Done.", "final_answer")]} />);

    expect(html).not.toContain("Reconnecting 1/3");
    expect(html).not.toContain("Connection error");
    expect(html).not.toContain("solar-refresh-linear spin");
    expect(html).toContain("Done.");
  });

  it("uses a failed retry as the single terminal connection error", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "retry",
      turnId: "turn-1",
      type: "retry",
      status: "failed",
      attempt: 3,
      maxAttempts: 3,
      delayMs: 4_000,
      error: { message: "stream disconnected" },
    }, {
      id: "assistant-error",
      turnId: "turn-1",
      type: "agentMessage",
      text: "",
      status: "failed",
      error: { message: "stream disconnected" },
    }]} failedTurnId="turn-1" />);

    expect(html.match(/Connection error/g)).toHaveLength(1);
    expect(html.match(/stream disconnected/g)).toHaveLength(1);
  });

  it("keeps an unclassified completed process message inside Worked", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "assistant-process",
      turnId: "turn-1",
      type: "agentMessage",
      text: "I am checking the project.",
      status: "completed",
    }]} />);

    expect(html).toContain("Worked for");
    expect(html.indexOf("Worked for")).toBeLessThan(html.indexOf("I am checking the project."));
  });

  it("uses the same assistant message style for commentary and final text", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I am checking the project.", "commentary"),
      assistant("final", "The project is ready.", "final_answer"),
    ]} />);

    expect(html).not.toContain("commentary-message");
    expect(html.match(/class="assistant-message assistant-completed"/g)).toHaveLength(2);
  });

  it("shows completed and current tools while a consecutive group is running", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...tool(), id: "read", toolCallId: "read" },
      {
        id: "edit",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "edit",
        tool: "edit",
        status: "inProgress",
        arguments: { path: "src/app.ts" },
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain('class="tool-label activity-shimmer" title="Edit Files">Edit Files<span class="activity-shimmer-highlight" aria-hidden="true">Edit Files</span></span>');
    expect(html).toContain('class="tool-label" title="Editing src/app.ts">Editing src/app.ts</span>');
    expect(html).toContain("package.json");
    expect(html).toContain('class="tool-activity-group"');
    expect(html.match(/class="tool-label activity-shimmer"/g)).toHaveLength(1);
    expect(html).not.toContain("solar-refresh-linear spin");
  });

  it("collapses an earlier activity group after commentary starts a new stage", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...tool(), id: "read-1", toolCallId: "read-1" },
      { ...tool(), id: "read-2", toolCallId: "read-2", arguments: { path: "src/app.ts" } },
      assistant("commentary", "Now I will run the checks.", "commentary"),
      {
        id: "check",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "check",
        tool: "bash",
        status: "inProgress",
        arguments: { command: "npm test" },
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Read files");
    expect(html).toMatch(/<summary class="tool-group-summary"><svg[^>]*class="solar solar-file-text-linear"/);
    expect(html).toContain("Now I will run the checks.");
    expect(html).toContain("Running npm test");
    expect(html.indexOf("Read files")).toBeLessThan(html.indexOf("Now I will run the checks."));
    expect(html.indexOf("Now I will run the checks.")).toBeLessThan(html.indexOf("Running npm test"));
  });

  it("reuses a completed mixed tool group row for Thinking", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      {
        id: "edit",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "edit",
        tool: "edit",
        status: "completed",
        arguments: { path: "src/app.ts" },
      },
      {
        id: "bash",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "bash",
        tool: "bash",
        status: "completed",
        arguments: { command: "npm run typecheck" },
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain('<span class="tool-label activity-shimmer" title="Thinking" role="status">Thinking<span class="activity-shimmer-highlight" aria-hidden="true">Thinking</span></span>');
    expect(html).toContain('<summary class="tool-group-summary tool-group-summary-thinking"><span class="tool-label activity-shimmer"');
    expect(html).not.toContain('class="thinking-activity"');
    expect(html).not.toContain("Edited a file, read a file, ran a command");
    expect(html).toContain("Read package.json");
    expect(html).toContain("Edited src/app.ts");
    expect(html).toContain("Ran npm run typecheck");
  });

  it("shows the Godot brand and operation for MCP tool calls", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "mcp",
        turnId: "turn-1",
        type: "mcpToolCall",
        toolCallId: "mcp",
        server: "ohmygame-godot",
        tool: "create_scene",
        status: "inProgress",
        arguments: { scenePath: "main.tscn" },
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Godot: Create scene");
    expect(html).toContain("tool-brand-godot");
    expect(html).not.toContain("Preparing mcp");
  });

  it("shows the Godot brand for MCP discovery operations", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "mcp-search",
        turnId: "turn-1",
        type: "mcpToolCall",
        toolCallId: "mcp-search",
        server: "ohmygame-godot",
        tool: "search_tools",
        status: "inProgress",
        arguments: { search: "scene" },
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Godot: Search tools");
    expect(html).toContain("tool-brand-godot");
  });

  it("uses a generic plug for unknown MCP servers", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "mcp",
        turnId: "turn-1",
        type: "mcpToolCall",
        toolCallId: "mcp",
        server: "custom-tools",
        tool: "fetch_asset",
        status: "inProgress",
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Custom tools: Fetch asset");
    expect(html).toContain("solar-plug-circle-linear");
  });

  it("uses an indefinite article for a single generic tool", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "image-tool",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "image-tool",
        tool: "image",
        status: "completed",
      },
      assistant("final", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Used an image tool");
  });

  it("uses an before an MCP initialism", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "mcp",
        turnId: "turn-1",
        type: "mcpToolCall",
        toolCallId: "mcp",
        tool: "fetch_asset",
        status: "completed",
      },
      assistant("final", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Used an MCP tool");
  });

  it("groups consecutive calls by their MCP integration", () => {
    const mcpTool = (id: string, operation: string): ThreadItem => ({
      id,
      turnId: "turn-1",
      type: "mcpToolCall",
      toolCallId: id,
      server: "ohmygame-godot",
      tool: operation,
      status: "completed",
    });
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      mcpTool("version", "get_godot_version"),
      mcpTool("run", "run_project"),
      assistant("final", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Used Godot tools");
    expect(html).toContain("Godot: Get Godot version");
    expect(html).toContain("Godot: Run project");
  });

  it("describes game use operations with player-facing labels", () => {
    const playtest = (id: string, operation: string, status: "inProgress" | "completed", extra: Record<string, unknown> = {}): ThreadItem => ({
      id,
      turnId: "turn-1",
      type: "dynamicToolCall",
      toolCallId: id,
      tool: "game_use",
      status,
      arguments: { operation, ...extra },
    });
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      playtest("open", "open", "completed"),
      playtest("single-act", "act", "completed", { actions: [{ type: "press", key: "Enter" }] }),
      playtest("act", "act", "completed", { actions: [{ type: "press", key: "Space" }, { type: "wait", milliseconds: 100 }] }),
      playtest("capture", "capture", "inProgress"),
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Capturing game screenshot");
    expect(html).toContain("Opened game preview");
    expect(html).toContain("Ran a playtest action");
    expect(html).toContain("Ran playtest actions");
    expect(html).not.toContain("Ran 2 playtest actions");
    expect(html).toContain("solar-gamepad-linear");
    expect(html).not.toContain("Used game_use");
  });

  it("summarizes completed game checks as a game playtest", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "open",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "open",
        tool: "game_use",
        status: "completed",
        arguments: { operation: "open" },
      },
      {
        id: "close",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "close",
        tool: "game_use",
        status: "completed",
        arguments: { operation: "close", sessionId: "session-1" },
      },
      assistant("final", "Verified.", "final_answer"),
    ]} />);

    expect(html).toContain("Playtested the game");
    expect(html).toContain("Closed game preview");
    expect(html).not.toContain("game_use tools");
  });

  it("shows a captured playtest frame inside the tool details", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "capture",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "capture",
        tool: "game_use",
        status: "completed",
        arguments: { operation: "capture", sessionId: "session-1" },
        output: "{\"width\":780,\"height\":1688}",
        images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      },
      assistant("final", "Verified.", "final_answer"),
    ]} />);

    expect(html).toContain("Captured game screenshot");
    expect(html).toContain('class="tool-result-images"');
    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(html.indexOf("tool-result-images")).toBeLessThan(html.indexOf("Input"));
  });

  it("keeps the generic MCP icon when unknown integrations are grouped", () => {
    const mcpTool = (id: string, operation: string): ThreadItem => ({
      id,
      turnId: "turn-1",
      type: "mcpToolCall",
      toolCallId: id,
      server: "custom-tools",
      tool: operation,
      status: "completed",
    });
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      mcpTool("fetch", "fetch_asset"),
      mcpTool("save", "save_asset"),
      assistant("final", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Used Custom tools");
    expect(html).toContain("solar-plug-circle-linear");
  });

  it("keeps tools on both sides of commentary while waiting", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      assistant("commentary", "Now I will edit it.", "commentary"),
      {
        id: "edit",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "edit",
        tool: "edit",
        status: "completed",
        arguments: { path: "src/app.ts" },
      },
    ]} activeTurnId="turn-1" />);

    expect(html.match(/<details class="tool-activity-group/g)).toHaveLength(2);
    expect(html.indexOf("Read package.json")).toBeLessThan(html.indexOf("Now I will edit it."));
    expect(html).toContain("Edited src/app.ts");
    expect(html.indexOf("Now I will edit it.")).toBeLessThan(html.indexOf("Thinking"));
  });

  it("renders images attached to the user message", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[{ ...user(), images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }]} />,
    );

    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(html).toContain("Attached image 1");
    expect(html).toContain('class="user-input"><div class="user-message-images"');
    expect(html).toContain('</div><div class="user-message">Build</div>');
  });

  it("renders non-image attachments without duplicating image attachments", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[{
      ...user(),
      images: [{ name: "references/hero.png", mediaType: "image/png", data: "aW1hZ2U=" }],
      attachments: [
        { name: "hero.png", relativePath: "references/hero.png", size: 5, kind: "image" },
        { name: "notes.md", relativePath: "references/notes.md", size: 1_024, kind: "text" },
      ],
    }]} />);

    expect(html).toContain("references/notes.md");
    expect(html).toContain("1 KB");
    expect(html).not.toContain(">references/hero.png</span>");
  });

  it("renders image-reading and completed compaction records", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "images", turnId: "turn-1", type: "imageRead", count: 2, status: "completed" },
      { id: "compaction", turnId: "compaction", type: "contextCompaction", status: "completed" },
    ]} />);

    expect(html).toContain("Viewed 2 images");
    expect(html).toContain("Context compacted");
  });

  it("folds standalone completed compaction into the original work before its final response", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      { ...user(), timestamp: 1_000 },
      { ...tool(), timestamp: 2_000 },
      { ...assistant("final", "Done.", "final_answer"), timestamp: 6_000 },
      { id: "compaction", turnId: "compaction", type: "contextCompaction", status: "completed", timestamp: 60_000, summary: "Previous work" },
    ]} />);

    expect(html.match(/<article class="agent-turn">/g)).toHaveLength(1);
    expect(html.match(/<details class="work-activity">/g)).toHaveLength(1);
    expect(html).toContain("Worked for 5s");
    expect(html).not.toContain("Worked for 0s");
    expect(html.indexOf("Context compacted")).toBeLessThan(html.indexOf("Done."));
  });

  it("expands completed compaction records with their summary and token counts", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      {
        id: "compaction",
        turnId: "compaction",
        type: "contextCompaction",
        status: "completed",
        summary: "## Goal\nKeep building the editor.",
        tokensBefore: 42_000,
        estimatedTokensAfter: 12_000,
      },
    ]} />);

    expect(html).toContain('class="compaction-details"');
    expect(html).toContain(`Compacted from ${new Intl.NumberFormat().format(42_000)} to approximately ${new Intl.NumberFormat().format(12_000)} tokens`);
    expect(html).toContain("Keep building the editor.");
    expect(html).not.toContain("Worked for");
  });

  it("renders failed and cancelled compaction states distinctly", () => {
    const failed = renderToStaticMarkup(<AgentTimeline items={[
      { id: "failed", turnId: "failed", type: "contextCompaction", status: "failed" },
    ]} />);
    const cancelled = renderToStaticMarkup(<AgentTimeline items={[
      { id: "cancelled", turnId: "cancelled", type: "contextCompaction", status: "cancelled" },
    ]} />);

    expect(failed).toContain("timeline-event-error");
    expect(failed).toContain("Context compaction failed");
    expect(cancelled).toContain("Context compaction stopped");
    expect(cancelled).not.toContain("timeline-event-error");
  });

  it("uses the compaction timestamp for an active turn duration", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      { id: "compaction", turnId: "compaction", type: "contextCompaction", status: "inProgress", timestamp: 1 },
    ]} activeTurnId="compaction" />);

    expect(html).toContain("Working for");
    expect(html).not.toContain("Working for 0s");
  });

  it("expands image-reading activity to show the viewed images", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      { ...user(), images: [{ name: "reference.png", mediaType: "image/png", data: "aW1hZ2U=" }] },
      { id: "images", turnId: "turn-1", type: "imageRead", count: 1, status: "completed" },
    ]} />);

    expect(html).toContain("Viewed an image");
    expect(html).toContain('class="image-read-previews"');
    expect(html).toContain('alt="reference.png"');
  });

  it("centers model switches between conversation turns", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("final", "Done.", "final_answer"),
      {
        id: "model-change",
        turnId: "model-change",
        type: "modelChange",
        model: { provider: "openai", id: "gpt-next" },
        name: "GPT Next",
      },
    ]} />);

    expect(html).toContain('class="model-change-event"');
    expect(html).toContain("Switched to GPT Next");
  });

  it("offers edit only on the latest user message", () => {
    const html = renderToStaticMarkup(<AgentTimeline
      items={[
        user(),
        { ...user(), id: "user-2", turnId: "turn-2", text: "Second" },
      ]}
      onRevise={async () => true}
    />);

    expect(html.match(/aria-label="Copy message"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Edit message"/g)).toHaveLength(1);
  });

  it("offers copy on final responses and keeps only the latest action visible", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("final-1", "First answer", "final_answer"),
      { ...user(), id: "user-2", turnId: "turn-2", text: "Second" },
      { ...assistant("final-2", "Second answer", "final_answer"), turnId: "turn-2" },
    ]} />);

    expect(html.match(/aria-label="Copy response"/g)).toHaveLength(2);
    expect(html.match(/assistant-response-latest/g)).toHaveLength(1);
    expect(html).toContain('class="assistant-response assistant-response-latest"');
  });

  it("does not offer response copy while a final answer is streaming", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...assistant("final", "Still writing", "final_answer"), status: "inProgress" },
    ]} activeTurnId="turn-1" />);

    expect(html).not.toContain('aria-label="Copy response"');
  });

  it("renders one copy action for multiple final text blocks in one turn", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("final-1", "First block", "final_answer"),
      assistant("final-2", "Second block", "final_answer"),
    ]} />);

    expect(html.match(/aria-label="Copy response"/g)).toHaveLength(1);
  });

  it("places one response footer after generated artifacts", () => {
    const html = renderToStaticMarkup(<AgentTimeline projectId="project-1" items={[
      user(),
      {
        ...tool(),
        artifact: { type: "image", path: "generated/image.png", mediaType: "image/png" },
      },
      assistant("final", "Here is the image.", "final_answer"),
    ]} />);

    expect(html.match(/assistant-response-footer/g)).toHaveLength(1);
    expect(html.match(/aria-label="Copy response"/g)).toHaveLength(1);
    expect(html.indexOf("tool-artifacts")).toBeLessThan(html.indexOf("assistant-response-footer"));
  });

  it("renders one response timestamp in the footer", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...assistant("final", "Done", "final_answer"), timestamp: Date.UTC(2026, 7, 23, 8, 5) },
    ]} />);

    expect(html.match(/<time /g)).toHaveLength(1);
    expect(html).toContain('dateTime="2026-08-23T08:05:00.000Z"');
  });

  it("lets users expand a command to inspect its output", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "command",
        turnId: "turn-1",
        type: "dynamicToolCall",
        toolCallId: "command",
        tool: "bash",
        status: "completed",
        arguments: { command: "npm test", cwd: "/workspace" },
        output: "Tests passed",
      },
    ]} />);

    expect(html).toContain('class="tool-activity-details"');
    expect(html).toContain("Shell");
    expect(html).toContain("npm test");
    expect(html).not.toContain("Arguments");
    expect(html).not.toContain("/workspace");
    expect(html).not.toContain("Output");
    expect(html).toContain("Tests passed");
  });

  it("presents web search as a first-class activity with provider fallback", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), {
      id: "search", turnId: "turn-1", type: "dynamicToolCall", toolCallId: "search", tool: "web_search", status: "completed",
      arguments: { query: "Godot 4.6 release" }, output: "https://godotengine.org/releases/4.6",
      webSearch: { provider: "parallel", providerName: "Parallel", fallbackFrom: "exa" },
    }]} />);

    expect(html).toContain("Searched the web for Godot 4.6 release");
    expect(html).toContain("Parallel");
    expect(html).toContain("Fallback used after Exa was unavailable");
    expect(html).toContain("https://godotengine.org/releases/4.6");
  });

  it("keeps existing work with its original prompt while a steer waits", () => {
    const activeTurn: Turn = {
      id: "turn-1",
      conversationId: "conversation-1",
      status: "inProgress",
      items: [
        user(),
        { ...tool(), status: "inProgress" },
      ],
    };
    const steeredTurn: Turn = {
      id: "turn-2",
      conversationId: "conversation-1",
      status: "completed",
      steering: true,
      items: [{ id: "steer-user", turnId: "turn-2", type: "userMessage", text: "Change direction" }],
    };

    const html = renderToStaticMarkup(<ThreadTimeline turns={[activeTurn, steeredTurn]} />);

    expect(html.indexOf("Working for")).toBeLessThan(html.indexOf("Change direction"));
    expect(html.indexOf("Working for")).toBeLessThan(html.indexOf("Reading package.json"));
    expect(html.indexOf("Change direction")).toBeLessThan(html.indexOf("Waiting to steer"));
    expect(html.match(/class="work-activity work-activity-active"/g)).toHaveLength(1);
  });

  it("shows the pending steer state only after the latest steered message", () => {
    const activeTurn: Turn = {
      id: "turn-1",
      conversationId: "conversation-1",
      status: "inProgress",
      items: [user(), { ...tool(), status: "inProgress" }],
    };
    const firstSteer: Turn = {
      id: "turn-2",
      conversationId: "conversation-1",
      status: "completed",
      steering: true,
      items: [{ id: "steer-user-1", turnId: "turn-2", type: "userMessage", text: "First change" }],
    };
    const secondSteer: Turn = {
      id: "turn-3",
      conversationId: "conversation-1",
      status: "completed",
      steering: true,
      items: [{ id: "steer-user-2", turnId: "turn-3", type: "userMessage", text: "Final change" }],
    };

    const html = renderToStaticMarkup(<ThreadTimeline turns={[activeTurn, firstSteer, secondSteer]} />);

    expect(html.indexOf("Working for")).toBeLessThan(html.indexOf("First change"));
    expect(html.indexOf("Final change")).toBeLessThan(html.indexOf("Waiting to steer"));
    expect(html.match(/Waiting to steer/g)).toHaveLength(2);
    expect(html.match(/class="work-activity work-activity-active"/g)).toHaveLength(1);
  });
  it("keeps failed tool details collapsed by default", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...tool(), status: "failed", output: "Permission denied" },
    ]} />);

    expect(html).toContain('<details class="tool-activity-details">');
    expect(html).not.toContain('<details class="tool-activity-details" open');
    expect(html).toContain("Permission denied");
  });

  it("keeps tools without inspectable data as plain rows", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...tool(), arguments: undefined },
    ]} />);

    expect(html).not.toContain("tool-activity-details");
  });

  it("does not expose read arguments as a generic inspector", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user(), tool()]} />);

    expect(html).toContain("Read package.json");
    expect(html).not.toContain("tool-activity-details");
    expect(html).not.toContain("Arguments");
  });
});

type ThreadItemOf<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;

function user(): ThreadItemOf<"userMessage"> {
  return { id: "user", turnId: "turn-1", type: "userMessage", text: "Build", timestamp: Date.now() - 1_000 };
}

function tool(): ThreadItemOf<"dynamicToolCall"> {
  return {
    id: "tool",
    turnId: "turn-1",
    type: "dynamicToolCall",
    toolCallId: "tool",
    tool: "read",
    status: "completed",
    arguments: { path: "package.json" },
    timestamp: Date.now(),
  };
}

function assistant(id: string, text: string, phase?: "commentary" | "final_answer"): ThreadItemOf<"agentMessage"> {
  return { id, turnId: "turn-1", type: "agentMessage", text, status: "completed", phase, timestamp: Date.now() };
}
