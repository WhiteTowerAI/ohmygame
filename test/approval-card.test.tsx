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
  ).toEqual(["Allow", "Deny"]);
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
  expect(labels()).toEqual(["Allow", "Always allow", "Deny"]);
  await render({ scope: "session", rules: [] });
  expect(labels()).toEqual(["Allow", "Allow for this conversation", "Deny"]);
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

it("shows the plugin, exact tool arguments and one-call choices for a plugin gate", async () => {
  const decide = vi.fn(async () => true);
  const input = '{"action":"click","x":120,"y":80,"text":"<literal>"}';
  await act(async () => root.render(<ApprovalCard request={{ ...request, request: { kind: "tool", tool: "desktop/click", title: "acme/guard: desktop/click", reason: "Control the desktop", input } }} agentName="OhMyGame" waiting={0} onDecide={decide} />));
  expect(container.textContent).toContain("acme/guard: desktop/click");
  expect(container.querySelector("pre")?.textContent).toBe(input);
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Allow", "Deny"]);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(decide).toHaveBeenCalledWith("allow");
});

it("keeps question selections across chat switches and submits distinct multi-select values", async () => {
  const { QuestionnaireCard } = await import("../src/renderer/questionnaire-card.js");
  const submit = vi.fn(async () => true);
  const interact = vi.fn(async () => true);
  const question: Extract<ThreadItem, { type: "userInputRequest" }> = {
    id: "draft-multi", turnId: "turn", requestId: "request", type: "userInputRequest", status: "inProgress",
    questions: [{ id: "q", prompt: "Which sections?", multiSelect: true, allowOther: true, options: [{ value: "a,b", label: "A and B" }, { value: "c", label: "C" }] }],
  };
  const render = () => <QuestionnaireCard request={question} onSubmit={submit} onSkip={async () => true} onInteract={interact} />;
  await act(async () => root.render(render()));
  const choose = (label: string) => [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;
  await act(async () => choose("A and B").click());
  expect(submit).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await act(async () => root.render(render()));
  expect(choose("A and B").getAttribute("aria-pressed")).toBe("true");
  await act(async () => choose("C").click());
  await act(async () => choose("Submit answers").click());
  expect(submit).toHaveBeenCalledWith([{ questionId: "q", value: "a,b, c", values: ["a,b", "c"] }]);
  expect(interact).not.toHaveBeenCalled();
});

it("keeps a failed answer editable, supports text-only questions, and explicitly stops the countdown", async () => {
  const { QuestionnaireCard } = await import("../src/renderer/questionnaire-card.js");
  const submit = vi.fn(async () => false);
  const interact = vi.fn(async () => true);
  const question: Extract<ThreadItem, { type: "userInputRequest" }> = {
    id: "text-only", turnId: "turn", requestId: "request", type: "userInputRequest", status: "inProgress",
    autoAnswerAt: Date.now() + 60_000,
    questions: [{ id: "q", prompt: "What name?", allowOther: true, options: [] }],
  };
  await act(async () => root.render(<QuestionnaireCard request={question} onSubmit={submit} onSkip={async () => true} onInteract={interact} />));
  expect(container.textContent).toContain("recommended answers in");
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Custom name");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(interact).toHaveBeenCalled();
  const submitButton = [...container.querySelectorAll("button")].find((item) => item.textContent === "Submit answers")!;
  await act(async () => submitButton.click());
  expect(submit).toHaveBeenCalledWith([{ questionId: "q", value: "Custom name" }]);
  expect(input.value).toBe("Custom name");
  expect(submitButton.disabled).toBe(false);
  expect(interact).toHaveBeenCalled();
  expect(container.querySelector('[role="timer"]')).toBeNull();
  expect(input.getAttribute("aria-label")).toBe("What name?");
});
