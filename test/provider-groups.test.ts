import { describe, expect, it } from "vitest";
import type { ProviderSummary } from "../src/shared/contracts.js";
import { groupProviders } from "../src/renderer/provider-groups.js";

const summary = (
  id: string,
  overrides: Partial<ProviderSummary> = {},
): ProviderSummary => ({
  id,
  name: id,
  configured: false,
  capabilities: ["language"],
  status: "not_configured",
  methods: [],
  ...overrides,
});
const ids = (providers: ProviderSummary[]) =>
  providers.map((provider) => provider.id);
const predicates = {
  isConnected: (provider: ProviderSummary) => provider.status === "connected",
  isFree: (provider: ProviderSummary) => provider.managed === "free_cloud",
  isLocal: (provider: ProviderSummary) => provider.preset === "ollama",
};

describe("provider groups", () => {
  it("puts every working connection first, including free cloud and local services", () => {
    const groups = groupProviders(
      [
        summary("cerebras"),
        summary("cloud-hyper3d", {
          managed: "free_cloud",
          status: "connected",
        }),
        summary("custom:ollama", { preset: "ollama", status: "connected" }),
        summary("anthropic", { status: "connected" }),
      ],
      predicates,
    );
    expect(ids(groups.connected)).toEqual([
      "cloud-hyper3d",
      "custom:ollama",
      "anthropic",
    ]);
    expect(groups.free).toEqual([]);
    expect(groups.local).toEqual([]);
    expect(ids(groups.more)).toEqual(["cerebras"]);
  });

  it("offers unconnected free, popular, and local providers in their own groups", () => {
    const groups = groupProviders(
      [
        summary("tripo", { capabilities: ["3d"] }),
        summary("cerebras"),
        summary("openrouter"),
        summary("cloud-hyper3d", { managed: "free_cloud" }),
        summary("custom:ollama", { preset: "ollama" }),
        summary("deepseek"),
        summary("openai"),
      ],
      predicates,
    );
    expect(ids(groups.free)).toEqual(["cloud-hyper3d"]);
    expect(ids(groups.popular)).toEqual([
      "openai",
      "openrouter",
      "deepseek",
      "tripo",
    ]);
    expect(ids(groups.local)).toEqual(["custom:ollama"]);
    expect(ids(groups.more)).toEqual(["cerebras"]);
  });
});

it("groups both Doubao services as one connection without hiding a Seed-only credential", async () => {
  const { withDoubaoConnection } = await import("../src/renderer/provider-groups.js");
  const services = [
    { id: "volcengine-tts", name: "Doubao Speech", configured: false, enabled: false, status: "not_configured", methods: [], capabilities: ["audio"] },
    { id: "volcengine-seed-audio", name: "Doubao Seed Audio", configured: true, enabled: true, status: "connected", methods: [], capabilities: ["audio"] },
  ] as import("../src/shared/contracts.js").ProviderSummary[];
  expect(withDoubaoConnection(services)).toMatchObject([{ id: "volcengine-tts", name: "Doubao Voice", configured: true, enabled: true }]);
  expect(services[0]!.configured).toBe(false);
});
