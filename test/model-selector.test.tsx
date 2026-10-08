import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { filterModels, groupModelsByProvider, ModelSelector } from "../src/renderer/model-selector.js";
import type { AgentModel } from "../src/shared/contracts.js";

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
