import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasDocumentAI, type CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import { readDocumentGenerations, type DocumentGenerationState } from "../src/renderer/use-canvas-documents.js";
import type { AgentModel } from "../src/shared/contracts.js";

afterEach(() => vi.unstubAllGlobals());
const model: AgentModel = { provider: "openai", providerName: "OpenAI", id: "test", name: "Test", reasoningLevels: ["off", "medium", "high"] };
const state: DocumentGenerationState = { instruction: "Improve the rules", model, reasoningLevel: "high", proposal: "## Partial draft\n\n可编辑内容", proposalStatus: "incomplete", error: "Provider connection lost" };

describe("document generation recovery", () => {
  it("restores editable text, instruction, selected model and failure without restarting generation", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ rules: state }) });
    expect(readDocumentGenerations("project").rules).toEqual({ ...state, model: { provider: model.provider, id: model.id } });
    expect(readDocumentGenerations("project").rules.generating).toBeUndefined();
  });
  it.each(["generating", "applying"])("recovers interrupted %s without a permanently busy editor", (busy) => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ rules: { ...state, [busy]: true } }) });
    const restored = readDocumentGenerations("project").rules;
    expect(restored).toMatchObject({ instruction: state.instruction, proposal: state.proposal, error: expect.stringContaining("interrupted") });
    expect(restored.generating).toBeUndefined();
    expect(restored.applying).toBeUndefined();
  });
  it.each(["invalid json", "null", "[]", '{"rules":{"instruction":12}}'])("ignores malformed recovery data %s", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readDocumentGenerations("project")).toEqual({});
  });
  it("shows an editable incomplete draft with retry, copy, discard and explicit adoption", () => {
    const html = render(state);
    expect(html).toContain("Incomplete draft");
    expect(html).toContain('aria-label="Candidate draft Markdown"');
    expect(html).toContain("Provider connection lost");
    for (const action of ["Retry document generation", "Copy candidate draft", "Discard candidate draft", "Replace document with draft", "Text model: Test"]) expect(html).toContain(`aria-label="${action}"`);
    expect(html).not.toContain("disabled");
    expect(html).toContain("Improve the rules");
  });
  it("leaves the instruction and retry visible when there is no candidate text", () => {
    const html = render({ ...state, proposal: undefined, proposalStatus: undefined, error: "The model returned no document text" });
    expect(html).toContain("Improve the rules");
    expect(html).toContain("no document text");
    expect(html).toContain('aria-label="Retry document generation"');
    expect(html).not.toContain('aria-label="Candidate draft Markdown"');
    expect(html).not.toContain("disabled");
  });
});

function render(generation: DocumentGenerationState) {
  const design = { generations: { rules: generation }, changeGeneration: () => {}, generate: () => {}, applyGeneration: () => {} } as unknown as CanvasDocuments;
  return renderToStaticMarkup(<CanvasDocumentAI design={design} document={{ id: "rules", title: "Rules", markdown: "Original document" }} textModels={{ models: [model], modelStatus: "ready", defaultModel: model }} />);
}
