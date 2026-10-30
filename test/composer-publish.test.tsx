// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/composer.js";
import { composerDrafts } from "../src/renderer/composer-drafts.js";
import { LIMIT_RESUME_MARGIN_MS, LIMIT_RESUME_PROMPT, limitResumeAt } from "../src/renderer/limit-resume.js";

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
    pendingPrompts: [],
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
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("handles the send button locally after the command menu is dismissed", async () => {
    const props = await render({
      initialDraft: { prompt: "/PUBLISH", mentions: [] },
    });
    await act(async () =>
      container
        .querySelector("textarea")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".send-button")!.click(),
    );
    expect(props.onPublish).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")?.value).toBe("");
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

describe("composer usage limit resume", () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const usage = (resetsAt: number) => vi.fn(async () => ({
    tokens: null,
    contextWindow: 200_000,
    percent: null,
    limits: [{ id: "claude/five_hour", usedPercent: 100, windowMinutes: 300, resetsAt }],
  }));
  afterEach(() => { vi.useRealTimers(); });

  it("finds when every exhausted window has reset", () => {
    expect(limitResumeAt([{ id: "a", usedPercent: 100, resetsAt: now / 1000 + 60 }, { id: "b", usedPercent: 40, resetsAt: now / 1000 + 600 }], now)).toBe(now + 60_000 + LIMIT_RESUME_MARGIN_MS);
    expect(limitResumeAt([{ id: "a", usedPercent: 100, resetsAt: now / 1000 - 60 }], now)).toBeUndefined();
    expect(limitResumeAt([{ id: "a", usedPercent: 100 }], now)).toBeUndefined();
  });

  it("sends one continue prompt after the reset only when the user opts in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(now);
    const props = await render({ model: { provider: "claude-code-cli", id: "default" }, initialDraft: undefined, limitReached: true, onContextUsage: usage(now / 1000 + 3600) });
    const button = () => container.querySelector<HTMLButtonElement>(".composer-resume button")!;
    expect(button().textContent).toBe("Continue after reset");
    await act(async () => { vi.advanceTimersByTime(1800_000); });
    expect(props.onSubmit).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(container.querySelector(".composer-resume")?.textContent).toContain("Continues automatically");
    await act(async () => { vi.advanceTimersByTime(1800_000 + LIMIT_RESUME_MARGIN_MS); });
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(LIMIT_RESUME_PROMPT, [], [], "normal", [], [], []);
  });

  it("keeps the scheduled continue through renders after the reset until the conversation moves on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(now);
    const props = await render({ model: { provider: "claude-code-cli", id: "default" }, initialDraft: undefined, limitReached: true, onContextUsage: usage(now / 1000 + 60) });
    const button = () => container.querySelector<HTMLButtonElement>(".composer-resume button")!;
    await act(async () => button().click());
    // The window resets at 60 s; an ordinary render inside the margin must not drop the 90 s schedule.
    await act(async () => { vi.advanceTimersByTime(61_000); });
    await act(async () => root.render(<Composer {...props} notice="Reconnecting" />));
    expect(container.querySelector(".composer-resume")?.textContent).toContain("Continues automatically");
    await act(async () => { vi.advanceTimersByTime(LIMIT_RESUME_MARGIN_MS); });
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith(LIMIT_RESUME_PROMPT, [], [], "normal", [], [], []);

    vi.mocked(props.onSubmit).mockClear();
    await act(async () => root.render(<Composer {...props} onContextUsage={usage(Date.now() / 1000 + 60)} model={{ provider: "claude-code-cli", id: "other" }} />));
    await act(async () => button().click());
    await act(async () => root.render(<Composer {...props} onContextUsage={usage(Date.now() / 1000 + 60)} model={{ provider: "claude-code-cli", id: "other" }} limitReached={false} />));
    await act(async () => { vi.advanceTimersByTime(3600_000); });
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("cancels the scheduled continue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(now);
    const props = await render({ model: { provider: "claude-code-cli", id: "default" }, initialDraft: undefined, limitReached: true, onContextUsage: usage(now / 1000 + 60) });
    const button = () => container.querySelector<HTMLButtonElement>(".composer-resume button")!;
    await act(async () => button().click());
    await act(async () => button().click());
    expect(button().textContent).toBe("Continue after reset");
    await act(async () => { vi.advanceTimersByTime(3600_000); });
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
