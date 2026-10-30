// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FloatingChat } from "../src/renderer/floating-chat.js";

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

const thread = (since: number) => <p className="since">{since}</p>;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

it("shows the turns that arrive after it opens, the latest three at most, and folds to a pill", async () => {
  const onExpand = vi.fn();
  const input = document.createElement("div");
  const prompt = document.createElement("textarea");
  input.append(prompt);
  const render = (turnCount: number, props: { running?: boolean; attention?: boolean } = {}) => act(async () => root.render(
    <FloatingChat turnCount={turnCount} thread={thread} running={props.running ?? false} attention={props.attention ?? false} onExpand={onExpand} input={input} />,
  ));
  await render(5);
  expect(container.querySelector(".floating-chat-input")!.contains(prompt)).toBe(true);
  // At rest it tells the area it floats over how much room it takes.
  expect(container.style.getPropertyValue("--floating-chat-clearance")).toMatch(/^\d+px$/);
  // The turns from before it opened stay in the chat panel.
  expect(container.querySelector(".since")).toBeNull();
  await render(6);
  expect(container.querySelector(".since")?.textContent).toBe("5");
  await render(10);
  expect(container.querySelector(".since")?.textContent).toBe("7");
  // Restored to an earlier turn, the thread starts again from there.
  await render(2);
  expect(container.querySelector(".since")).toBeNull();
  await render(3);
  expect(container.querySelector(".since")?.textContent).toBe("2");

  await act(async () => button("Open in the chat panel").click());
  expect(onExpand).toHaveBeenCalledOnce();

  // Folded, the input stays in the bar, hidden, so what was typed is kept.
  prompt.value = "half a thought";
  await act(async () => button("Fold").click());
  expect(container.querySelector<HTMLElement>(".floating-chat-input")!.hidden).toBe(true);
  expect(input.isConnected && prompt.value).toBe("half a thought");
  await render(3, { running: true });
  expect(container.querySelector(".floating-chat-pill")?.textContent).toBe("Working…");
  // Something waiting on an answer unfolds it.
  await render(3, { running: true, attention: true });
  expect(container.querySelector<HTMLElement>(".floating-chat-input")!.hidden).toBe(false);

  // Gone, it leaves the input out of sight for the chat panel to take back.
  await act(async () => root.render(null));
  expect(container.contains(input)).toBe(false);
  expect(input.closest(".dock-parking")).not.toBeNull();
  expect(container.style.getPropertyValue("--floating-chat-clearance")).toBe("");
});
