import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasTextComposer } from "../src/renderer/canvas-text-composer.js";
import type { AgentModel } from "../src/shared/contracts.js";

const model: AgentModel = { provider: "openai", providerName: "OpenAI", id: "test", name: "Test", reasoningLevels: ["off", "medium", "high"] };
const props = { models: [model], modelStatus: "ready" as const, defaultModel: model, instruction: "Write", onModel: () => {}, onInstruction: () => {}, onReasoningChange: () => {}, onGenerate: () => {} };

describe("canvas text reasoning", () => {
  it("uses the configured default and clamps unsupported saved reasoning", () => {
    expect(renderToStaticMarkup(<CanvasTextComposer {...props} defaultReasoningLevel="high" />)).toContain('aria-label="Reasoning: High"');
    expect(renderToStaticMarkup(<CanvasTextComposer {...props} reasoningLevel="max" />)).toContain('aria-label="Reasoning: High"');
  });

  it("hides reasoning for a model with a single supported level", () => {
    expect(renderToStaticMarkup(<CanvasTextComposer {...props} models={[{ ...model, reasoningLevels: ["off"] }]} />)).not.toContain('aria-label="Reasoning:');
  });
});
