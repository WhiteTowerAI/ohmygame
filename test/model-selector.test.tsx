// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterModels, groupModelsByProvider, ModelSelector } from "../src/renderer/model-selector.js";
import type { AgentModel, AgentReasoningLevel } from "../src/shared/contracts.js";

const model: AgentModel = {
  provider: "openai",
  providerName: "OpenAI",
  id: "gpt-test",
  name: "GPT Test",
  reasoningLevels: ["off", "medium"],
};

describe("ModelSelector", () => {
  it("searches model names, IDs and provider metadata without changing their order", () => {
    const available = [model, { ...model, provider: "relay", providerName: "My Gateway", id: "vendor/fast", name: "Fast Model" }];
    expect(filterModels(available, "  GPT-TEST ")).toEqual([model]);
    expect(filterModels(available, "gateway")).toEqual([available[1]]);
    expect(filterModels(available, "fast model")).toEqual([available[1]]);
    expect(filterModels(available, "missing")).toEqual([]);
    expect(filterModels(available, " ")).toEqual(available);
  });
  it("allows recovery when models are available but none is selected", () => {
    const html = renderToStaticMarkup(
      <ModelSelector models={[model]} onChange={() => undefined} onReasoningChange={() => undefined} />,
    );

    expect(html).toContain("No language model");
    expect(html).not.toContain("disabled=\"\"");
  });

  it("stays disabled when no models are available", () => {
    const html = renderToStaticMarkup(
      <ModelSelector models={[]} onChange={() => undefined} onReasoningChange={() => undefined} />,
    );

    expect(html).toContain("disabled=\"\"");
  });

  it("keeps the current conversation model named when it is hidden from the menu", () => {
    const html = renderToStaticMarkup(
      <ModelSelector models={[]} value={model} onChange={() => undefined} onReasoningChange={() => undefined} />,
    );
    expect(html).toContain("GPT Test");
    expect(html).not.toContain("No language model");
  });

  it("groups models by provider while preserving provider and model order", () => {
    const groups = groupModelsByProvider([
      model,
      { ...model, provider: "anthropic", providerName: "Anthropic", id: "claude-test", name: "Claude Test" },
      { ...model, id: "gpt-test-mini", name: "GPT Test Mini" },
    ]);

    expect(groups.map((group) => ({
      provider: group.provider,
      providerName: group.providerName,
      models: group.models.map((item) => item.name),
    }))).toEqual([
      { provider: "openai", providerName: "OpenAI", models: ["GPT Test", "GPT Test Mini"] },
      { provider: "anthropic", providerName: "Anthropic", models: ["Claude Test"] },
    ]);
  });
});

describe("ModelSelector interaction", () => {
  let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
  const reasoningModel: AgentModel = { ...model, reasoningLevels: ["low", "medium", "high", "xhigh", "max"] };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it.each(["chat", "canvas"] as const)("shows the model and reasoning in one button and changes depth through its menu in the %s variant", async (variant) => {
    const onChange = vi.fn(), onReasoningChange = vi.fn();
    function Selector() {
      const [level, setLevel] = useState<AgentReasoningLevel>("high");
      return <ModelSelector variant={variant} models={[reasoningModel]} value={reasoningModel} reasoningLevel={level} onChange={onChange} onReasoningChange={(next) => { onReasoningChange(next); setLevel(next); }} />;
    }
    await act(async () => root.render(<Selector />));
    expect(container.querySelectorAll("button")).toHaveLength(1);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent).toContain(model.name);
    expect(button.querySelector(".model-selector-reasoning-value")?.textContent).toBe("High");
    await act(async () => button.click());
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Models");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search models");
    await act(async () => document.querySelector<HTMLButtonElement>(".model-selector-reasoning")!.click());
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("Reasoning levels");
    expect(menu.parentElement?.id).toBe(button.getAttribute("aria-controls"));
    expect(menu.textContent).toContain("xHigh");
    expect(menu.textContent).not.toContain("Extra high");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("High");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("xHigh");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(onReasoningChange).toHaveBeenCalledExactlyOnceWith("xhigh");
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.querySelector(".model-selector-reasoning-value")?.textContent).toBe("xHigh");
    expect(button.getAttribute("aria-description")).toBe("Reasoning: xHigh");
  });

  it("returns from reasoning with Escape, arrow keys or Back, and restores focus when closing", async () => {
    await act(async () => root.render(<ModelSelector models={[reasoningModel]} value={reasoningModel} onChange={() => {}} onReasoningChange={() => {}} />));
    const button = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".model-selector-reasoning")!.click());
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Models");
    expect(document.activeElement).toBe(document.querySelector(".model-selector-reasoning"));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Reasoning levels");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(document.querySelector(".model-selector-reasoning"));
    await act(async () => document.querySelector<HTMLButtonElement>(".model-selector-reasoning")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Back to models"]')!.click());
    expect(document.activeElement).toBe(document.querySelector(".model-selector-reasoning"));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("clamps the level when switching models and hides reasoning for a single supported level", async () => {
    const limited: AgentModel = { ...model, id: "limited", name: "Limited", reasoningLevels: ["off", "low", "high"] };
    const fixed: AgentModel = { ...model, id: "fixed", name: "Fixed", reasoningLevels: ["off"] };
    const onChange = vi.fn();
    function Selector() {
      const [selected, setSelected] = useState(reasoningModel);
      const [level, setLevel] = useState<AgentReasoningLevel>("xhigh");
      return <ModelSelector models={[reasoningModel, limited, fixed]} value={selected} reasoningLevel={level} onReasoningChange={() => {}} onChange={(next, reasoning) => {
        onChange(next, reasoning); setSelected(next); setLevel(reasoning);
      }} />;
    }
    await act(async () => root.render(<Selector />));
    const modelButton = container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
    await act(async () => modelButton.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[title="openai/limited"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith(limited, "high");
    expect(modelButton.querySelector(".model-selector-reasoning-value")?.textContent).toBe("High");
    expect(document.activeElement).toBe(modelButton);
    await act(async () => modelButton.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[title="openai/fixed"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith(fixed, "off");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(modelButton.querySelector(".model-selector-reasoning-value")).toBeNull();
    await act(async () => modelButton.click());
    expect(document.querySelector(".model-selector-reasoning")).toBeNull();
  });

  it("disables the button and closes an open reasoning menu while the composer is busy", async () => {
    const props = { models: [reasoningModel], value: reasoningModel, onChange: () => {}, onReasoningChange: () => {} };
    await act(async () => root.render(<ModelSelector {...props} />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".model-selector-reasoning")!.click());
    await act(async () => root.render(<ModelSelector {...props} disabled />));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
  });
});
