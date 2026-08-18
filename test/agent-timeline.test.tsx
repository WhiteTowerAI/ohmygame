import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentTimeline } from "../src/renderer/agent-timeline.js";
import type { AgentItem } from "../src/shared/contracts.js";

describe("AgentTimeline", () => {
  it("shows Thinking outside before work begins", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user()]} activeTurnId="turn-1" thinking />,
    );

    expect(html).toContain("Thinking");
    expect(html).toContain("thinking-activity");
    expect(html).not.toContain("Working for");
    expect(html).not.toContain("Worked");
    expect(html).not.toContain("<details");
  });

  it("replaces initial Thinking with elapsed work when work begins", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user(), tool()]} activeTurnId="turn-1" />,
    );

    expect(html).toContain("Working for");
    expect(html).toContain("Reading package.json");
    expect(html).not.toContain("thinking-activity");
    expect(html).not.toContain("<details class=\"work-activity\"");
  });

  it("keeps a direct answer outside Working while streaming and after completion", () => {
    const streaming = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { ...assistant("response", "Hello"), status: "streaming", phase: undefined },
    ]} activeTurnId="turn-1" />);
    const complete = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("response", "Hello", "final_answer"),
    ]} />);

    expect(streaming).toContain("Hello");
    expect(streaming).not.toContain("Working");
    expect(complete).toContain("Hello");
    expect(complete).not.toContain("Worked");
  });

  it("renders successful and failed tools as static rows without output", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      {
        id: "failed-tool",
        turnId: "turn-1",
        kind: "tool",
        toolCallId: "failed-tool",
        toolName: "bash",
        status: "error",
        args: { command: "npm run build" },
        output: "private build output",
      },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("npm run build");
    expect(html).not.toContain("private build output");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<button");
  });

  it("renders assistant text and tools in Pi event order without regrouping", () => {
    const items = [
      user(),
      assistant("note", "I will inspect it."),
      tool(),
      assistant("response", "Done."),
    ];
    const html = renderToStaticMarkup(<AgentTimeline items={items} />);

    expect(html.indexOf("I will inspect it.")).toBeLessThan(html.indexOf("Reading package.json"));
    expect(html.indexOf("Reading package.json")).toBeLessThan(html.indexOf("Done."));
    expect(html).not.toContain("Working");
    expect(html).not.toContain("Worked");
    const activeHtml = renderToStaticMarkup(<AgentTimeline items={items} activeTurnId="turn-1" />);
    expect(activeHtml).toContain("Working for");
    expect(activeHtml).not.toContain("<details class=\"work-activity\"");
    expect(activeHtml).toContain("active-work-items");
    expect(activeHtml).not.toContain("class=\"work-items\"");
    expect(activeHtml.indexOf("I will inspect it.")).toBeLessThan(activeHtml.indexOf("Reading package.json"));
    expect(activeHtml.indexOf("Reading package.json")).toBeLessThan(activeHtml.indexOf("Done."));
  });

  it("renders Pi thinking as a compact non-expandable row", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", kind: "thinking", text: "Inspect the project structure.", status: "complete" },
    ]} />);

    expect(html).toContain("Thinking");
    expect(html).not.toContain("Inspect the project structure.");
    expect(html).toContain("thinking-block");
    expect(html).not.toContain("<details");
  });

  it("keeps active Thinking, commentary, and tools in source order", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", kind: "thinking", text: "private", status: "complete" },
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
    ]} activeTurnId="turn-1" />);

    expect(html.indexOf("Thinking")).toBeLessThan(html.indexOf("I will inspect it."));
    expect(html.indexOf("I will inspect it.")).toBeLessThan(html.indexOf("Reading package.json"));
  });

  it("groups Codex commentary and tools while keeping the final answer outside", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
      assistant("response", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Worked for");
    expect(html.indexOf("I will inspect it.")).toBeLessThan(html.indexOf("Reading package.json"));
    expect(html.indexOf("Reading package.json")).toBeLessThan(html.indexOf("Done."));
    expect(html.indexOf('class="work-items"')).toBeLessThan(html.indexOf("I will inspect it."));
    expect(html.indexOf("Done.")).toBeGreaterThan(html.indexOf("</details>"));
  });

  it("renders images attached to the user message", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[{ ...user(), images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }]} />,
    );

    expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(html).toContain("Attached image 1");
    expect(html).toContain('class="user-input"><div class="user-message-images"');
    expect(html).toContain('</div><div class="user-message">Build</div></div>');
  });
});

function user(): AgentItem {
  return { id: "user", turnId: "turn-1", kind: "user", text: "Build", timestamp: Date.now() - 1_000 };
}

function tool(): AgentItem {
  return {
    id: "tool",
    turnId: "turn-1",
    kind: "tool",
    toolCallId: "tool",
    toolName: "read",
    status: "complete",
    args: { path: "package.json" },
    timestamp: Date.now(),
  };
}

function assistant(id: string, text: string, phase?: "commentary" | "final_answer"): AgentItem {
  return { id, turnId: "turn-1", kind: "assistant", text, status: "complete", phase, timestamp: Date.now() };
}
