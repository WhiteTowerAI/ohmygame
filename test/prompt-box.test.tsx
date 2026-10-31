// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptBox } from "../src/renderer/prompt-box.js";
import type { PluginMention } from "../src/shared/contracts.js";
import { placeCaret, pressKey, promptChips, promptField, promptText, typePrompt } from "./prompt-field.js";

const blender: PluginMention = { name: "blender", displayName: "Blender", marketplaceId: "bundled" };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Box({ initial = "", readOnly = false, onSubmit = () => {}, onValue = (_: string) => {} }: { initial?: string; readOnly?: boolean; onSubmit?: () => void; onValue?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <PromptBox value={value} onChange={(next) => { setValue(next); onValue(next); }} onSubmit={onSubmit} placeholder="Ask for a change"
    variant="project" actions={null} readOnly={readOnly} mentions={[blender]} skills={["review", "game-design"]} />;
}

describe("PromptBox", () => {
  it("shows the plugins and Skills the prompt names as chips, and keeps its text as sent", async () => {
    await act(async () => root.render(<Box initial="@Blender model a ship with $review and $game-design. Costs $5" />));
    expect(promptChips(host)).toEqual(["Blender", "Review", "Game Design"]);
    expect(promptText(host)).toBe("@Blender model a ship with $review and $game-design. Costs $5");
  });

  it("removes a chip whole, and reports the text without it", async () => {
    const onValue = vi.fn();
    await act(async () => root.render(<Box initial="$review now" onValue={onValue} />));
    await placeCaret("$review".length, host);
    await pressKey("Backspace", {}, host);
    // happy-dom has no beforeinput, so Lexical deletes on the key itself.
    expect(promptChips(host)).toEqual([]);
    expect(onValue).toHaveBeenLastCalledWith(" now");
  });

  it("sends on Enter, and leaves a typed name as text", async () => {
    const onSubmit = vi.fn();
    const onValue = vi.fn();
    await act(async () => root.render(<Box onSubmit={onSubmit} onValue={onValue} />));
    await typePrompt("Use $review", host);
    expect(onValue).toHaveBeenLastCalledWith("Use $review");
    // A name being typed stays text, so it never turns into a chip under the caret.
    expect(promptChips(host)).toEqual([]);
    const enter = await pressKey("Enter", {}, host);
    expect(enter.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Composition keys are the input method's own.
    await pressKey("Enter", { isComposing: true }, host);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows a name the prompt gains from outside as a chip, and continues a list on Shift+Enter", async () => {
    const onValue = vi.fn();
    const render = (value: string) => act(async () => root.render(<PromptBox value={value} onChange={onValue} onSubmit={() => {}}
      placeholder="" variant="project" actions={null} skills={["review"]} />));
    await render("Check it");
    await render("$review Check it");
    expect(promptChips(host)).toEqual(["Review"]);
    expect(onValue).not.toHaveBeenCalled();

    await render("- one");
    await placeCaret(5, host);
    await pressKey("Enter", { shiftKey: true }, host);
    expect(onValue).toHaveBeenLastCalledWith("- one\n- ");
  });

  it("stays focusable while read-only, but takes no input and sends nothing", async () => {
    const onSubmit = vi.fn();
    await act(async () => root.render(<Box initial="hi" readOnly onSubmit={onSubmit} />));
    const field = promptField(host);
    expect(field.getAttribute("contenteditable")).toBe("true");
    expect(field.getAttribute("aria-readonly")).toBe("true");
    expect(field.classList.contains("nokey")).toBe(true);
    expect((await pressKey("Enter", {}, host)).defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    await placeCaret(2, host);
    await pressKey("Backspace", {}, host);
    expect(promptText(host)).toBe("hi");
  });
});
