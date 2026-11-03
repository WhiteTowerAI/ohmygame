// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/composer.js";
import { composerDrafts } from "../src/renderer/composer-drafts.js";
import { pressKey, promptChips, promptText } from "./prompt-field.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  composerDrafts.deleteProject("publish-test");
  vi.unstubAllGlobals();
});

async function render(
  overrides: Partial<ComponentProps<typeof Composer>> = {},
) {
  const props: ComponentProps<typeof Composer> = {
    projectId: "publish-test",
    conversationId: "chat",
    conversationReady: true,
    running: false,
    stopping: false,
    pendingPrompts: [], scheduledMessages: [],
    planMode: "normal",
    models: [],
    modelStatus: "ready",
    modelChanging: false,
    promptHistory: [],
    capabilities: { plugins: [], skills: [] },
    initialDraft: { prompt: "/publish", mentions: [] },
    onSubmit: vi.fn(async () => true),
    onCompact: vi.fn(async () => {}),
    onContextUsage: vi.fn(async () => undefined),
    onCancelPlan: vi.fn(async () => true),
    onModelChange: vi.fn(),
    onReasoningChange: vi.fn(),
    onStop: vi.fn(),
    onRemovePending: vi.fn(async () => true),
    onSteerPending: vi.fn(async () => true),
    onEditPending: vi.fn(async () => true),
    onScheduleMessage: vi.fn(async () => true),
    onRemoveScheduled: vi.fn(async () => true),
    canPublish: true,
    onPublish: vi.fn(),
    ...overrides,
  };
  await act(async () => root.render(<Composer {...props} />));
  return props;
}

describe("composer publish command", () => {
  it("opens publishing from the menu while retaining coding agent quota information", async () => {
    const props = await render({
      model: { provider: "codex-cli", id: "test" },
      onContextUsage: vi.fn(async () => ({
        tokens: null,
        contextWindow: 200_000,
        percent: null,
        limits: [{ id: "codex/primary", usedPercent: 42, windowMinutes: 300 }],
      })),
    });
    expect(
      container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"),
    ).toBe("42");
    const command =
      container.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(command.textContent).toContain("Publish game");
    await act(async () => command.click());
    expect(props.onPublish).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(promptText(container)).toBe("");
  });

  it("handles the send button locally after the command menu is dismissed", async () => {
    const props = await render({
      initialDraft: { prompt: "/PUBLISH", mentions: [] },
    });
    await pressKey("Escape", {}, container);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".send-button")!.click(),
    );
    expect(props.onPublish).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(promptText(container)).toBe("");
  });

  it.each([
    { running: true },
    { stopping: true },
    { canPublish: false },
    { onPublish: undefined },
  ])("hides publishing when unavailable: %j", async (overrides) => {
    const props = await render(overrides);
    expect(container.querySelector('[role="option"]')).toBeNull();
    if (props.onPublish) expect(props.onPublish).not.toHaveBeenCalled();
  });

  it("preserves ordinary messages that mention publishing", async () => {
    const props = await render({
      initialDraft: { prompt: "Explain /publish", mentions: [] },
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".send-button")!.click(),
    );
    expect(props.onPublish).not.toHaveBeenCalled();
    expect(props.onSubmit).toHaveBeenCalledWith(
      "Explain /publish",
      [],
      [],
      "normal",
      [],
      [],
      [],
    );
  });
});

describe("composer status line", () => {
  it("shows the latest response's speed and cache hits and how full the context is, without loading a session", async () => {
    const onContextUsage = vi.fn(async () => ({ tokens: 11220, contextWindow: 128000, percent: 8.77, lastResponse: { outputTokens: 420, tokensPerSecond: 81, cacheHitPercent: 86 } }));
    await render({ initialDraft: undefined, onContextUsage });
    expect(onContextUsage).toHaveBeenCalledWith(true);
    const status = container.querySelector(".composer-status")!;
    expect(status.textContent).toBe("81 tok/sCache hit 86%9%");
    await act(async () => status.querySelector<HTMLButtonElement>(".composer-status-context")!.click());
    expect(document.querySelector(".composer-status-popover")?.textContent).toContain("~11.2K / 128K");
  });
});

describe("composer later command", () => {
  const send = () => act(async () => container.querySelector<HTMLButtonElement>(".send-button")!.click());
  const alertText = () => container.querySelector(".composer-error")?.textContent;
  const later = (prompt: string) => ({ initialDraft: { prompt, mentions: [] } });

  it("schedules what follows the time and empties the box, sending nothing now", async () => {
    const props = await render(later("/later 2h Fix the tests"));
    await send();
    expect(props.onScheduleMessage).toHaveBeenCalledExactlyOnceWith("Fix the tests", expect.any(Number));
    const [, at] = vi.mocked(props.onScheduleMessage).mock.calls[0];
    expect(Math.abs(at - Date.now() - 2 * 3_600_000)).toBeLessThan(5_000);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(promptText(container)).toBe("");
  });

  it("schedules with Enter while the command list is open", async () => {
    const props = await render(later("/later 30m Fix the tests"));
    expect(container.querySelector('[role="option"]')?.textContent).toContain("/later");
    await pressKey("Enter", {}, container);
    expect(props.onScheduleMessage).toHaveBeenCalledExactlyOnceWith("Fix the tests", expect.any(Number));
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the message and says why when there is no time to read", async () => {
    const props = await render(later("/later Fix the tests"));
    await send();
    expect(props.onScheduleMessage).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(alertText()).toContain("Add a time after /later");
    expect(promptText(container)).toBe("/later Fix the tests");
  });

  it("keeps the message when the schedule is refused", async () => {
    await render({ ...later("/later 2h Fix the tests"), onScheduleMessage: vi.fn(async () => false) });
    await send();
    expect(promptText(container)).toBe("/later 2h Fix the tests");
  });

  it("refuses what a later message couldn't carry", async () => {
    composerDrafts.get({ projectId: "publish-test", conversationId: "chat" }).update({ prompt: "/later 2h Look", reference: { text: "Quoted" } as never });
    const props = await render({ initialDraft: undefined });
    await send();
    expect(props.onScheduleMessage).not.toHaveBeenCalled();
    expect(alertText()).toContain("text only");
  });

  it("refuses in plan mode, where the message would lose the plan's limits", async () => {
    const props = await render({ ...later("/later 2h Look"), planMode: "planning" });
    await send();
    expect(props.onScheduleMessage).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(alertText()).toContain("plan mode");
  });

  it("completes the command from the list, keeping the time to write", async () => {
    const props = await render(later("/lat"));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(props.onScheduleMessage).not.toHaveBeenCalled();
    expect(promptText(container)).toBe("/later ");
  });

  it("isn't offered where it can't run", async () => {
    await render({ ...later("/later"), planMode: "planning" });
    expect([...container.querySelectorAll('[role="option"]')].map((option) => option.textContent)).not.toContainEqual(expect.stringContaining("/later"));
  });

  it("shows a scheduled message's time, and removes it", async () => {
    const at = Date.UTC(2026, 9, 26, 12, 0, 0);
    const props = await render({ initialDraft: undefined, scheduledMessages: [{ id: "one", prompt: "Run the tests", at }, { id: "two", prompt: "Missed one", at, missed: true }] });
    const rows = [...container.querySelectorAll(".message-queue-row")];
    expect(rows[0].textContent).toContain("Run the tests");
    expect(rows[0].querySelector(".message-queue-time")?.textContent).toBe(new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
    expect(rows[1].querySelector(".message-queue-time.is-missed")?.textContent).toContain("Missed");
    await act(async () => rows[0].querySelector<HTMLButtonElement>('button[title="Remove scheduled message"]')!.click());
    expect(props.onRemoveScheduled).toHaveBeenCalledExactlyOnceWith("one");
  });

  it("puts a message back as a command with the time it has left", async () => {
    const props = await render({ initialDraft: undefined, scheduledMessages: [{ id: "one", prompt: "Run the tests", at: Date.now() + 90 * 60_000 }] });
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Edit scheduled message"]')!.click());
    expect(props.onRemoveScheduled).toHaveBeenCalledExactlyOnceWith("one");
    expect(promptText(container)).toMatch(/^\/later (90|91)m Run the tests$/);
  });

  it("puts a missed message back as plain text, to send or put a new time on", async () => {
    await render({ initialDraft: undefined, scheduledMessages: [{ id: "one", prompt: "Run the tests", at: 1, missed: true }] });
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Edit scheduled message"]')!.click());
    expect(promptText(container)).toBe("Run the tests");
  });
});

describe("composer usage limit resume", () => {
  it("skips the continue when the person is writing", async () => {
    const onSkipLimitResume = vi.fn();
    await render({ limitResumeArmed: true, onSkipLimitResume, initialDraft: { prompt: "Wait, change direction", mentions: [] } });
    expect(onSkipLimitResume).toHaveBeenCalledOnce();
  });

  it.each([
    ["an empty composer", { limitResumeArmed: true, initialDraft: undefined }],
    ["nothing armed", { limitResumeArmed: false, initialDraft: { prompt: "Wait", mentions: [] } }],
  ])("leaves it alone with %s", async (_, props) => {
    const onSkipLimitResume = vi.fn();
    await render({ ...props, onSkipLimitResume });
    expect(onSkipLimitResume).not.toHaveBeenCalled();
  });
});

describe("composer mentions", () => {
  const blender = { id: "bundled/blender", name: "blender", displayName: "Blender", description: "3D", marketplaceId: "bundled", marketplaceDisplayName: "Bundled" };
  const capabilities = { plugins: [blender], skills: [{ name: "review", description: "Review a change" }, { name: "game-design", description: "Write a brief" }] };
  const mention = { name: "blender", displayName: "Blender", marketplaceId: "bundled" };

  it("shows each plugin and Skill in the text as a chip, and sends the text as written", async () => {
    const props = await render({ capabilities, canPublish: false, initialDraft: { prompt: "$review the @Blender scene with $game-design", mentions: [mention] } });
    expect(promptChips(container)).toEqual(["Review", "Blender", "Game Design"]);
    await act(async () => container.querySelector<HTMLButtonElement>(".send-button")!.click());
    expect(props.onSubmit).toHaveBeenCalledWith("$review the @Blender scene with $game-design", [mention], [], "normal", [], [], []);
  });

  it("brings a Skill and plugin saved in slots before the text back into it", async () => {
    localStorage.setItem("ohmygame:composer-draft:v1:publish-test:chat", JSON.stringify({
      version: 1, prompt: "fix the scene", mentions: [mention], selectedSkill: "review", selectedPlugin: mention, planning: false,
    }));
    await render({ capabilities, canPublish: false, initialDraft: undefined });
    expect(promptText(container)).toBe("$review @Blender fix the scene");
    expect(promptChips(container)).toEqual(["Review", "Blender"]);
  });
});
