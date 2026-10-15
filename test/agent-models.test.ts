import { describe, expect, it } from "vitest";
import { findAgentModel, preferredAgentModel, recommendedAgentModel } from "../src/shared/agent-models.js";

const models = [
  { provider: "one", id: "first", name: "First" },
  { provider: "two", id: "second", name: "Second" },
];

describe("agent model selection", () => {
  it("prefers an available explicit selection", () => {
    expect(preferredAgentModel(models, { provider: "two", id: "second" }, { provider: "one", id: "first" }))
      .toBe(models[1]);
  });

  it("falls back to the configured default and then the first model", () => {
    expect(preferredAgentModel(models, { provider: "missing", id: "missing" }, { provider: "two", id: "second" }))
      .toBe(models[1]);
    expect(preferredAgentModel(models, undefined, { provider: "missing", id: "missing" })).toBe(models[0]);
    expect(preferredAgentModel([], undefined, { provider: "one", id: "first" })).toBeUndefined();
  });

  it("finds only exact provider and model matches", () => {
    expect(findAgentModel(models, { provider: "one", id: "first" })).toBe(models[0]);
    expect(findAgentModel(models, { provider: "two", id: "first" })).toBeUndefined();
  });

  it("recommends a provider's flagship model and falls back to its first model", () => {
    const catalog = [
      { provider: "anthropic", id: "claude-3-haiku" },
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "custom:local", id: "local" },
    ];
    expect(recommendedAgentModel(catalog, "anthropic")).toBe(catalog[1]);
    expect(recommendedAgentModel(catalog.slice(0, 1), "anthropic")).toBe(catalog[0]);
    expect(recommendedAgentModel(catalog, "custom:local")).toBe(catalog[2]);
    expect(recommendedAgentModel(catalog, "openai")).toBeUndefined();
  });
});
