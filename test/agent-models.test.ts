import { describe, expect, it } from "vitest";
import { findAgentModel, preferredAgentModel } from "../src/shared/agent-models.js";

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
});
