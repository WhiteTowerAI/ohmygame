import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentTimeline } from "../src/renderer/agent-timeline.js";
import type { AgentItem } from "../src/shared/contracts.js";

describe("AgentTimeline", () => {
  it("shows Thinking before the turn has visible work", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user()]} activeTurnId="turn-1" thinking />,
    );

    expect(html).toContain("Thinking for");
    expect(html).not.toContain("thinking-activity");
  });

  it("keeps Working as the title when Pi thinks between activities", () => {
    const html = renderToStaticMarkup(
      <AgentTimeline items={[user(), tool()]} activeTurnId="turn-1" thinking />,
    );

    expect(html).toContain("Working for");
    expect(html).toContain('class="work-summary-current" title="Thinking"');
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
