import { describe, expect, it } from "vitest";
import { initialCustomThinkingLevelMap, invalidateCustomModelCapabilities, mergeDiscoveredProviderModels, modelError } from "../src/renderer/custom-provider-models.js";
import { AGENT_REASONING_LEVELS, type CustomProviderModel } from "../src/shared/contracts.js";
import { supportedReasoningLevels } from "../src/shared/reasoning.js";
import { defaultImageSettings, defaultVideoSettings } from "../src/shared/custom-models.js";

const model: CustomProviderModel = { id: "model", name: "My renamed model", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: true, thinkingLevelMap: { max: "ultra" } };

describe("custom provider model refresh", () => {
  const catalogMap = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

  it("retains catalog levels after endpoint changes when switching from Automatic to Custom", () => {
    const automatic: CustomProviderModel = { ...model, reasoning: true, thinkingLevelMap: undefined, reasoningCapabilities: { source: "catalog", thinkingLevelMap: catalogMap } };
    const changed = invalidateCustomModelCapabilities(automatic);
    const custom = { ...changed, thinkingLevelMap: initialCustomThinkingLevelMap(changed) };
    expect(supportedReasoningLevels(custom)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(custom.thinkingLevelMap).toEqual(catalogMap);
    expect(modelError(custom)).toBeUndefined();
  });

  it("falls back from remote to catalog metadata and preserves manual settings across protocol changes", () => {
    const remote: CustomProviderModel = { ...model, reasoningCapabilities: { source: "provider", thinkingLevelMap: { max: "ultra" }, catalogThinkingLevelMap: catalogMap } };
    for (const api of [model.api, "openai-responses"]) {
      expect(invalidateCustomModelCapabilities(remote, api)).toEqual({ ...remote, api, reasoningCapabilities: { source: "catalog", thinkingLevelMap: catalogMap } });
    }
    expect(invalidateCustomModelCapabilities(remote, "anthropic-messages")).toEqual({ ...remote, api: "anthropic-messages", reasoningCapabilities: undefined });
    expect(invalidateCustomModelCapabilities({ ...remote, reasoningCapabilities: { source: "provider", thinkingLevelMap: { max: "ultra" } } }).reasoningCapabilities).toBeUndefined();
    const row = { model: remote, enabled: false };
    expect({ ...row, model: invalidateCustomModelCapabilities(row.model) }).toMatchObject({ enabled: false, model: { reasoning: false, thinkingLevelMap: model.thinkingLevelMap } });
  });

  it("allows disabled reasoning with no enabled levels but still rejects malformed parameters", () => {
    const disabled = { ...model, thinkingLevelMap: Object.fromEntries(AGENT_REASONING_LEVELS.map((level) => [level, null])) };
    expect(modelError(disabled)).toBeUndefined();
    expect(modelError({ ...disabled, reasoning: true })).toContain("Enable at least one");
    const partial = { ...model, reasoningCapabilities: { source: "provider" as const, thinkingLevelMap: { ...disabled.thinkingLevelMap, low: "low" } }, thinkingLevelMap: { low: null } };
    expect(modelError(partial)).toBeUndefined();
    expect(modelError({ ...partial, reasoning: true })).toContain("Enable at least one");
    for (const parameter of ["", "bad\nvalue", "x".repeat(101)]) expect(modelError({ ...disabled, thinkingLevelMap: { max: parameter } })).toContain("Enter a parameter");
  });

  it("updates existing automatic capabilities while preserving edited fields, enable state and manual mappings", () => {
    const row = { model, enabled: false };
    const reported = { source: "provider" as const, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
    const merged = mergeDiscoveredProviderModels([row], [{ ...model, name: "Remote name", reasoning: true, contextWindow: 128_000, thinkingLevelMap: undefined, reasoningCapabilities: reported }, { ...model, id: "new", name: "New model", thinkingLevelMap: undefined }]);
    expect(merged[0]).toEqual({ ...row, model: { ...model, reasoningCapabilities: reported } });
    expect(merged[1]).toMatchObject({ model: { id: "new" }, enabled: false });
    expect(row.model).not.toHaveProperty("reasoningCapabilities");
  });

  it("preserves configured media uses and manual aliases when discovery changes or removes a model", () => {
    const configured = { ...model, usages: { image: { ...defaultImageSettings("gemini-generate-content"), baseUrl: "https://images.example/v1beta", maxReferenceImages: 7 }, video: defaultVideoSettings("seedance") } };
    const row = { model: configured, enabled: true };
    const manual = { model: { ...model, id: "manual-alias", usages: {} }, enabled: false };
    const merged = mergeDiscoveredProviderModels([row, manual], [{ ...model, name: "Remote name", usages: { language: true } }, { ...model, id: "new-alias", name: "New", usages: {} }]);
    expect(merged.find((item) => item.model.id === model.id)).toEqual({ ...row, model: { ...configured, reasoningCapabilities: undefined } });
    expect(merged.find((item) => item.model.id === "manual-alias")).toBe(manual);
    expect(merged.find((item) => item.model.id === "new-alias")).toMatchObject({ enabled: false, model: { usages: {} } });
    expect(modelError(merged.find((item) => item.model.id === "new-alias")!.model, true)).toContain("Choose a use");
  });

  it("replaces stale remote capabilities when a subsequent fetch reports no capabilities", () => {
    const row = { model: { ...model, reasoningCapabilities: { source: "provider" as const, thinkingLevelMap: { max: "ultra" } } }, enabled: true };
    expect(mergeDiscoveredProviderModels([row], [model])[0]).toEqual({ ...row, model: { ...model, reasoningCapabilities: undefined } });
    expect(mergeDiscoveredProviderModels([row], [])[0]).toBe(row);
  });

  it("does not replace protocol-specific capabilities with an unrelated discovery response", () => {
    const capabilities = { source: "catalog" as const, thinkingLevelMap: { xhigh: null, max: null } };
    const row = { model: { ...model, api: "anthropic-messages", reasoningCapabilities: capabilities }, enabled: false };
    const reported = { source: "provider" as const, thinkingLevelMap: { max: "ultra" } };
    const discovered = { ...model, reasoningCapabilities: reported };
    expect(mergeDiscoveredProviderModels([row], [discovered])[0]).toEqual(row);
    const compatible = { ...row, model: { ...row.model, api: "openai-responses" } };
    expect(mergeDiscoveredProviderModels([compatible], [discovered])[0]).toEqual({ ...compatible, model: { ...compatible.model, reasoningCapabilities: reported } });
  });
});
