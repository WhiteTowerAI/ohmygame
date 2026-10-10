import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasTextComposer } from "../src/renderer/canvas-text-composer.js";
import { CanvasNodeReferenceStrip } from "../src/renderer/canvas-node-references.js";
import type { AgentModel } from "../src/shared/contracts.js";

const model: AgentModel = { provider: "openai", providerName: "OpenAI", id: "test", name: "Test", reasoningLevels: ["off", "medium", "high"] };
const props = { models: [model], modelStatus: "ready" as const, defaultModel: model, instruction: "Write", onModel: () => {}, onInstruction: () => {}, onReasoningChange: () => {}, onGenerate: () => {} };

describe("canvas text reasoning", () => {
  it("renders reference thumbnails inside the composer and leaves an empty strip invisible", () => {
    expect(renderToStaticMarkup(<CanvasNodeReferenceStrip references={[]} onRemoveReference={() => {}} />)).toBe("");
    const html = renderToStaticMarkup(<CanvasTextComposer {...props} references={<CanvasNodeReferenceStrip references={[{ nodeId: "brief", type: "text", name: "Brief", text: "Forest adventure" }]} onRemoveReference={() => {}} />} />);
    expect(html).toMatch(/^<div class="story-text-composer nodrag nowheel"><div class="story-media-references" aria-label="Node references">/);
    expect(html).toContain('aria-label="Remove Brief"');
    expect(html.indexOf('aria-label="Node references"')).toBeLessThan(html.indexOf('aria-label="Text generation instruction"'));
    expect(html).not.toContain("Connect Text");
  });
  it("uses the configured default and clamps unsupported saved reasoning", () => {
    expect(renderToStaticMarkup(<CanvasTextComposer {...props} defaultReasoningLevel="high" />)).toContain('title="Text model: OpenAI · Test · Reasoning: High"');
    expect(renderToStaticMarkup(<CanvasTextComposer {...props} reasoningLevel="max" />)).toContain('title="Text model: OpenAI · Test · Reasoning: High"');
  });

  it("hides reasoning for a model with a single supported level", () => {
    expect(renderToStaticMarkup(<CanvasTextComposer {...props} models={[{ ...model, reasoningLevels: ["off"] }]} />)).not.toContain('Reasoning:');
  });
});
