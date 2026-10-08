import { describe, expect, it } from "vitest";
import type { RuntimeModel } from "../src/daemon/agent.js";
import { customModelCatalog, knownCustomModel, resolveCustomModelCapabilities } from "../src/daemon/custom-model-capabilities.js";
import { normalizeCustomProviderModel } from "../src/daemon/provider-model-settings.js";
import { AGENT_REASONING_LEVELS } from "../src/shared/contracts.js";
import { supportedReasoningLevels } from "../src/shared/reasoning.js";

const upstream: RuntimeModel = {
  provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-responses", baseUrl: "https://api.example/v1",
  reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
};
const relay: RuntimeModel = { ...upstream, provider: "custom-relay", api: "openai-completions", thinkingLevelMap: undefined };
const catalog = customModelCatalog([upstream]);

describe("custom model reasoning resolution", () => {
  it("uses explicit overrides before provider metadata before the upstream catalog", () => {
    const reported = { ...upstream.thinkingLevelMap, xhigh: null, max: "ultra" };
    expect(resolveCustomModelCapabilities(relay, catalog, reported).thinkingLevelMap?.max).toBe("ultra");
    const resolved = resolveCustomModelCapabilities({ ...relay, thinkingLevelMap: { high: null, max: "relay-max" } }, catalog, reported);
    expect(resolved.thinkingLevelMap).toMatchObject({ high: null, xhigh: null, max: "relay-max" });
    expect(supportedReasoningLevels(resolved)).toEqual(["low", "medium", "max"]);
    expect(relay.thinkingLevelMap).toBeUndefined();
    expect(upstream.thinkingLevelMap?.max).toBe("max");
  });

  it("matches exact and qualified IDs while keeping unknown aliases conservative", () => {
    expect(knownCustomModel("openai/gpt-6.1-sol", relay.api, catalog)).toBe(upstream);
    const unknown = { ...relay, id: "my-gpt-6.1-sol-alias" };
    expect(supportedReasoningLevels(resolveCustomModelCapabilities(unknown, catalog))).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(knownCustomModel(upstream.id, relay.api, customModelCatalog([{ ...relay, thinkingLevelMap: { max: "ultra" } }, upstream]))).toBe(upstream);
  });

  it("does not enable disabled reasoning or copy maps across unrelated protocols", () => {
    const disabled = { ...relay, reasoning: false };
    expect(resolveCustomModelCapabilities(disabled, catalog)).toBe(disabled);
    expect(supportedReasoningLevels(disabled)).toEqual(["off"]);
    const incompatible = { ...relay, api: "anthropic-messages" as const };
    expect(resolveCustomModelCapabilities(incompatible, catalog).thinkingLevelMap).toBeUndefined();
  });

  it("validates manual and reported mappings before persisting them", () => {
    const model = { id: relay.id, name: relay.name, contextWindow: 128_000, maxTokens: 16_384, reasoning: true, supportsImages: false };
    const allDisabled = Object.fromEntries(AGENT_REASONING_LEVELS.map((level) => [level, null]));
    for (const thinkingLevelMap of [null, [], { max: 20 }, { max: "" }, { max: "bad\nvalue" }, { ultra: "ultra" }, allDisabled]) {
      expect(() => normalizeCustomProviderModel({ ...model, thinkingLevelMap }, relay.api, relay.baseUrl, catalog)).toThrow();
    }
    expect(() => normalizeCustomProviderModel({ ...model, reasoningCapabilities: { source: "provider" } }, relay.api, relay.baseUrl)).toThrow();
    expect(() => normalizeCustomProviderModel({ ...model, reasoningCapabilities: { source: "provider", thinkingLevelMap: { ...allDisabled, low: "low" } }, thinkingLevelMap: { low: null } }, relay.api, relay.baseUrl)).toThrow("Enable at least one");
    expect(normalizeCustomProviderModel({ ...model, thinkingLevelMap: { max: " ultra " } }, relay.api, relay.baseUrl).thinkingLevelMap).toEqual({ max: "ultra" });
  });
});
