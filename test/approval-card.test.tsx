// @vitest-environment happy-dom
import i18next from "i18next";
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
    "Always allow also covers: Bash(git push:*)",
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

it("words a Library add in the person's language instead of its English request", async () => {
  const library: Extract<ThreadItem, { type: "approvalRequest" }> = {
    ...request,
    request: {
      kind: "tool",
      tool: "asset_use",
      title: "Add broadsword.svg from Icon pack",
      reason: "Downloads it from Icon pack into your Library and copies it into this project. By Lorc, CC BY 3.0. https://icons.example/broadsword.html",
      input: JSON.stringify({ source: "example/icon-pack:icons", item: "lorc/broadsword", mediaType: "image" }),
      libraryAdd: { name: "broadsword.svg", source: "Icon pack", author: "Lorc", license: "CC BY 3.0", url: "https://icons.example/broadsword.html" },
    },
  };
  const render = () => act(async () => root.render(<ApprovalCard request={library} waiting={0} onDecide={async () => true} />));
  await render();
  expect(container.textContent).toContain("Add broadsword.svg from Icon pack?");
  expect(container.textContent).toContain("By Lorc · License: CC BY 3.0");
  expect(container.textContent).toContain("https://icons.example/broadsword.html");
  // The English request and its ids aren't shown again beside it.
  expect(container.textContent).not.toContain("Downloads it from");
  expect(container.textContent).not.toContain("lorc/broadsword");
  expect(approvalOutcomeLabel({ ...library, status: "completed", decision: "allow" })).toBe("Allowed: broadsword.svg");

  const previousLanguage = i18next.language;
  await i18next.changeLanguage("zh-CN");
  try {
    await render();
    expect(container.textContent).toContain("从Icon pack添加 broadsword.svg？");
    expect(container.textContent).toContain("作者：Lorc · 许可证：CC BY 3.0");
    expect(container.textContent).not.toContain("Add broadsword.svg");
  } finally {
    await i18next.changeLanguage(previousLanguage);
  }
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

it.each([false, true])("offers a manual answer as a choice and preserves multi-select=%s", async (multiSelect) => {
  const { QuestionnaireCard } = await import("../src/renderer/questionnaire-card.js");
  const submit = vi.fn(async () => true);
  const interact = vi.fn(async () => true);
  const question: Extract<ThreadItem, { type: "userInputRequest" }> = {
    id: `manual-option-${multiSelect}`, turnId: "turn", requestId: "request", type: "userInputRequest", status: "inProgress",
    autoAnswerAt: Date.now() + 60_000,
    questions: [{ id: "q", prompt: "Which platform?", multiSelect, allowOther: true, options: [{ value: "web", label: "Web" }] }],
  };
  await act(async () => root.render(<QuestionnaireCard request={question} onSubmit={submit} onSkip={async () => true} onInteract={interact} />));
  expect(container.querySelector('[aria-label="Previous question"]')).toBeNull();
  expect(container.querySelector("input")).toBeNull();
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => button("Web").click());
  await act(async () => button("Answer manually").click());
  expect(button("Answer manually").getAttribute("aria-pressed")).toBe("true");
  expect(button("Web").getAttribute("aria-pressed")).toBe(String(multiSelect));
  expect(button("Submit answers").disabled).toBe(true);
  expect(container.querySelector('[role="timer"]')).toBeNull();
  const input = container.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mobile");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Submit answers").click());
  expect(submit).toHaveBeenCalledWith([multiSelect
    ? { questionId: "q", value: "web, Mobile", values: ["web", "Mobile"] }
    : { questionId: "q", value: "Mobile" }]);
  expect(interact).toHaveBeenCalledOnce();
});

it("makes saved plugin consent explicit and keeps allow-once separate", async () => {
  const decide = vi.fn(async () => true);
  const scoped = { ...request, request: { kind: "tool" as const, tool: "desktop/click", reason: "Read and operate the app", input: '{"app":"com.apple.TextEdit"}', pluginAccess: { plugin: "ohmygame/computer-use", label: "com.apple.TextEdit" }, always: { scope: "saved" as const, rules: ["com.apple.TextEdit"] } } };
  await act(async () => root.render(<ApprovalCard request={scoped} waiting={0} onDecide={decide} />));
  expect(container.textContent).toContain("Allow access to com.apple.TextEdit?");
  expect(container.textContent).toContain("Revoke it in the plugin's settings");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Allow and remember", "Allow once", "Deny"]);
  await act(async () => buttons[0]!.click());
  expect(decide).toHaveBeenLastCalledWith("allow-always");
  await act(async () => root.render(<ApprovalCard request={{ ...scoped, requestId: "another" }} waiting={0} onDecide={decide} />));
  await act(async () => buttons[1]!.click());
  expect(decide).toHaveBeenLastCalledWith("allow");
});
