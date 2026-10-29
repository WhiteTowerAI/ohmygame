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
    always: { scope: "saved", rules: ["Bash(git push:*)"] },
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
  // The agent's own description of what always allowing covers.
  expect(container.textContent).toContain(
    "Allowing beyond this request covers: Bash(git push:*)",
  );
  const always = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Always allow",
  )!;
  await act(async () => {
    always.click();
    always.click();
  });
  expect(decide).toHaveBeenCalledOnce();
  expect(decide).toHaveBeenCalledWith("allow-always");
});

it("shows every read/write root and network scope before a permission grant", async () => {
  await act(async () =>
    root.render(
      <ApprovalCard
        request={{
          ...request,
          request: {
            kind: "other",
            tool: "permissions",
            paths: [
              { path: "/reference", access: "read" },
              { path: "/export", access: "write" },
            ],
            network: true,
          },
        }}
        waiting={0}
        onDecide={async () => true}
      />,
    ),
  );
  expect(container.textContent).toContain("/reference");
  expect(container.textContent).toContain("/export");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.textContent).toContain("Network access");
  expect(container.textContent).not.toContain("Always allow");
  expect(container.textContent).not.toContain("Allow for this conversation");
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
          },
        }}
        waiting={0}
        onDecide={async () => true}
      />,
    ),
  );
  expect(container.textContent).toContain("The agent wants to access files");
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

it("keeps a failed approval request answerable and identifies granted paths in history", async () => {
  const decide = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(true);
  await act(async () =>
    root.render(
      <ApprovalCard request={request} waiting={0} onDecide={decide} />,
    ),
  );
  const allow = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Allow",
  )!;
  await act(async () => allow.click());
  expect(allow.disabled).toBe(false);
  await act(async () => allow.click());
  expect(decide).toHaveBeenCalledTimes(2);
  expect(
    approvalOutcomeLabel({
      ...request,
      request: {
        kind: "other",
        tool: "permissions",
        paths: [{ path: "/reference", access: "read" }],
      },
      status: "completed",
      decision: "allow",
    }),
  ).toContain("/reference");
});

it("names how long allowing beyond this request lasts, as the agent offers it", async () => {
  const render = (always: NonNullable<(typeof request)["request"]["always"]>) =>
    act(async () =>
      root.render(
        <ApprovalCard
          request={{ ...request, request: { ...request.request, always } }}
          waiting={0}
          onDecide={vi.fn(async () => true)}
        />,
      ),
    );
  const labels = () =>
    [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
  await render({ scope: "saved", rules: [] });
  expect(labels()).toEqual(["Deny", "Always allow", "Allow"]);
  await render({ scope: "session", rules: [] });
  expect(labels()).toEqual(["Deny", "Allow for this conversation", "Allow"]);
  expect(container.textContent).not.toContain("covers");
});

it("labels answered requests, including conversation grants stored before", () => {
  const answered = (
    decision: NonNullable<(typeof request)["decision"]>,
    scope: "saved" | "session" = "saved",
  ) =>
    approvalOutcomeLabel({
      ...request,
      request: { ...request.request, always: { scope, rules: [] } },
      status: "completed",
      decision,
    });
  expect(answered("allow-always")).toBe("Always allowed: git push origin main");
  expect(answered("allow-always", "session")).toBe(
    "Allowed for this conversation: git push origin main",
  );
  expect(answered("allow-session")).toBe(
    "Allowed for this conversation: git push origin main",
  );
});
