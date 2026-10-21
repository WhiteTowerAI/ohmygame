// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/composer.js";
import { composerDrafts } from "../src/renderer/composer-drafts.js";

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
