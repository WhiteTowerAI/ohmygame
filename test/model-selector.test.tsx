import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupModelsByProvider, ModelSelector } from "../src/renderer/model-selector.js";

const model = {
  provider: "openai",
  providerName: "OpenAI",
  id: "gpt-test",
  name: "GPT Test",
  reasoningLevels: ["off", "medium"] as const,
};

describe("ModelSelector", () => {
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
