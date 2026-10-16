// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApprovalCard,
  approvalOutcomeLabel,
} from "../src/renderer/approval-card.js";
import { projectTurnDisplay } from "../src/renderer/turn-display.js";
import type { ThreadItem } from "../src/shared/contracts.js";

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const request: Extract<ThreadItem, { type: "approvalRequest" }> = {
  id: "turn-1:approval:call-1",
  turnId: "turn-1",
  type: "approvalRequest",
  requestId: "call-1",
  request: {
    kind: "command",
    tool: "Bash",
    command: "git push origin main",
    reason: "Publishes the branch",
    canAllowSession: true,
  },
  status: "inProgress",
};

it("shows what the agent wants to run and sends one answer", async () => {
  const decide = vi.fn(async () => true);
  await act(async () =>
    root.render(
      <ApprovalCard
        request={request}
        agentName="Claude Code"
        waiting={1}
        onDecide={decide}
      />,
    ),
  );
  expect(container.textContent).toContain("Claude Code wants to run a command");
  expect(container.textContent).toContain("git push origin main");
  expect(container.textContent).toContain("Publishes the branch");
  expect(container.textContent).toContain("1 more waiting");
  const allow = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Allow for this conversation",
  )!;
  await act(async () => {
    allow.click();
    allow.click();
  });
  expect(decide).toHaveBeenCalledOnce();
  expect(decide).toHaveBeenCalledWith("allow-session");
});

it("offers only a single answer when the agent cannot remember one", async () => {
  await act(async () =>
    root.render(
      <ApprovalCard
        request={{
          ...request,
          request: {
            kind: "file",
            tool: "Write",
            path: "/etc/hosts",
            canAllowSession: false,
          },
        }}
        waiting={0}
        onDecide={async () => true}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "The agent wants to change files outside the project",
  );
  expect(
    [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Deny", "Allow"]);
});

it("keeps waiting requests out of the timeline and shows answered ones as work", () => {
  expect(
    approvalOutcomeLabel({ ...request, status: "completed", decision: "deny" }),
  ).toBe("Denied: git push origin main");
  const user: ThreadItem = {
    id: "u",
    turnId: "turn-1",
    type: "userMessage",
    text: "push",
  };
  const waiting = projectTurnDisplay({
    id: "turn-1",
    conversationId: "c",
    status: "inProgress",
    items: [user, request],
  });
  expect(JSON.stringify(waiting)).not.toContain("approvalRequest");
  const answered = projectTurnDisplay({
    id: "turn-1",
    conversationId: "c",
    status: "completed",
    items: [user, { ...request, status: "completed", decision: "allow" }],
  });
  expect(JSON.stringify(answered)).toContain("approvalRequest");
});
