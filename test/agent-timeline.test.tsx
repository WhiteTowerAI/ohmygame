import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentTimeline as ThreadTimeline } from "../src/renderer/agent-timeline.js";
import type { ComponentProps } from "react";
import type { ThreadItem, Turn } from "../src/shared/contracts.js";

function AgentTimeline({ items, activeTurnId, ...props }: Omit<ComponentProps<typeof ThreadTimeline>, "turns"> & { items: ThreadItem[]; activeTurnId?: string }) {
  const grouped = new Map<string, ThreadItem[]>();
  for (const item of items) grouped.set(item.turnId, [...(grouped.get(item.turnId) ?? []), item]);
  const turns: Turn[] = [...grouped].map(([id, turnItems]) => ({
    id,
    conversationId: "conversation-1",
    status: id === activeTurnId ? "inProgress" : "completed",
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

  it("shows Pi's streamed reasoning summary before work begins", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "**Planning Vite app creation**", status: "inProgress" },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Planning Vite app creation");
    expect(html).not.toContain("**");
  });

  it("replaces initial Thinking with elapsed work when work begins", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user(), tool()]} activeTurnId="turn-1" />,
    );

    expect(html).toContain("Working for");
    expect(html.match(/<div class="work-summary work-summary-active">([\s\S]*?)<\/div>/)?.[1]).not.toContain("lucide-loader-circle");
    expect(html).toContain("Thinking");
    expect(html).not.toContain("Read package.json");
    expect(html).not.toContain("tool-activity-group");
    expect(html).not.toContain("<details class=\"work-activity\"");
  });

  it("spins only the initial Thinking header", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[user()]} activeTurnId="turn-1" />);

    expect(html).toContain("lucide-loader-circle spin");
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

  it("replaces the latest completed tool group while waiting for the next step", () => {
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
    expect(html).not.toContain("Ran npm run build");
    expect(html).not.toContain("private build output");
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

  it("replaces the latest tool with Thinking after earlier commentary", () => {
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
    expect(html).not.toContain("Read package.json");
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

  it("uses the current activity row for Thinking between tool calls", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      assistant("commentary", "I will inspect it.", "commentary"),
      tool(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "Planning the next edit", status: "inProgress" },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Working for");
    expect(html).toContain("Planning the next edit");
    expect(html).not.toContain("package.json");
    expect(html).not.toContain("tool-activity-group");
  });

  it("replaces a completed Thinking summary with the generic status", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      tool(),
      { id: "thinking", turnId: "turn-1", type: "reasoning", text: "Planning the next edit", status: "completed" },
    ]} activeTurnId="turn-1" />);

    expect(html).toContain("Thinking");
    expect(html).not.toContain("Planning the next edit");
    expect(html).not.toContain("Read package.json");
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
    expect(html).not.toContain("tool-activity-group");
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

  it("shows only the current tool while a consecutive tool group is running", () => {
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

    expect(html).toContain("Editing src/app.ts");
    expect(html).not.toContain("package.json");
    expect(html).not.toContain("tool-activity-group");
  });

  it("uses one Thinking row after a completed mixed tool group", () => {
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

    expect(html).toContain("Thinking");
    expect(html).not.toContain("Edited a file, read a file, ran a command");
    expect(html).not.toContain("Read package.json");
    expect(html).not.toContain("Edited src/app.ts");
    expect(html).not.toContain("Ran npm run typecheck");
  });

  it("shows the Godot brand and operation for MCP tool calls", () => {
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      {
        id: "mcp",
        turnId: "turn-1",
        type: "mcpToolCall",
        toolCallId: "mcp",
        server: "opengame-godot",
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
        server: "opengame-godot",
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
    expect(html).toContain("lucide-plug");
  });

  it("groups consecutive calls by their MCP integration", () => {
    const mcpTool = (id: string, operation: string): ThreadItem => ({
      id,
      turnId: "turn-1",
      type: "mcpToolCall",
      toolCallId: id,
      server: "opengame-godot",
      tool: operation,
      status: "completed",
    });
    const html = renderToStaticMarkup(<AgentTimeline items={[
      user(),
      mcpTool("version", "get_godot_version"),
      mcpTool("run", "run_project"),
      assistant("final", "Done.", "final_answer"),
    ]} />);

    expect(html).toContain("Used Godot 2 times");
    expect(html).toContain("Godot: Get Godot version");
    expect(html).toContain("Godot: Run project");
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

    expect(html).toContain("Used Custom tools 2 times");
    expect(html).toContain("lucide-plug");
  });

  it("keeps earlier tools and replaces only the current trailing tool", () => {
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

    expect(html).not.toContain("tool-activity-group");
    expect(html.indexOf("Read package.json")).toBeLessThan(html.indexOf("Now I will edit it."));
    expect(html).not.toContain("Edited src/app.ts");
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
});

function user(): ThreadItem {
  return { id: "user", turnId: "turn-1", type: "userMessage", text: "Build", timestamp: Date.now() - 1_000 };
}

function tool(): ThreadItem {
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

function assistant(id: string, text: string, phase?: "commentary" | "final_answer"): ThreadItem {
  return { id, turnId: "turn-1", type: "agentMessage", text, status: "completed", phase, timestamp: Date.now() };
}
