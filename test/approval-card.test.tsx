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
            canAllowSession: false,
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
  expect(container.textContent).toContain("Allow network access for this turn");
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
            canAllowSession: false,
          },
        }}
        waiting={0}
        onDecide={async () => true}
      />,
    ),
  );
  expect(container.textContent).toContain(
    "The agent wants to access files outside the project",
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
        canAllowSession: false,
      },
      status: "completed",
      decision: "allow",
    }),
  ).toContain("/reference");
});

it("names what allowing for the conversation covers", async () => {
  const render = (
    sessionScope: NonNullable<(typeof request)["request"]["sessionScope"]>,
  ) =>
    act(async () =>
      root.render(
        <ApprovalCard
          request={{
            ...request,
            request: { ...request.request, sessionScope },
          }}
          waiting={0}
          onDecide={vi.fn(async () => true)}
        />,
      ),
    );
  const labels = () =>
    [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
  await render({ commands: ["git push"] });
  expect(labels()).toContain("Allow git push for this conversation");
  await render({ readFolders: ["/Users/me/notes"] });
  expect(labels()).toContain("Allow reading notes/ for this conversation");
});
