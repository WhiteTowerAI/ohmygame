import { describe, expect, it } from "vitest";
import type { ProviderSummary } from "../src/shared/contracts.js";
import { withLocalModelProviders } from "../src/renderer/local-model-providers.js";

describe("local provider entries", () => {
  it("offers local setup even when no providers have been configured", () => {
    expect(withLocalModelProviders([])).toEqual([
      expect.objectContaining({ id: "ollama", name: "Ollama", preset: "ollama", configured: false, capabilities: ["language"] }),
      expect.objectContaining({ id: "lmstudio", name: "LM Studio", preset: "lmstudio", configured: false, capabilities: ["language"] }),
    ]);
  });

  it("uses a renamed, disabled saved connection without adding a duplicate setup entry", () => {
    const saved: ProviderSummary = {
      id: "custom-local", name: "Home server", preset: "ollama", custom: true,
      configured: true, status: "connected", enabled: false, methods: [], capabilities: ["language"],
    };
    const providers = [saved];
    const listed = withLocalModelProviders(providers);
    expect(listed.filter((provider) => provider.preset === "ollama")).toEqual([saved]);
    expect(listed.find((provider) => provider.preset === "lmstudio")?.configured).toBe(false);
    expect(providers).toEqual([saved]);
  });

  it("keeps multiple saved connections to the same local service", () => {
    const saved: ProviderSummary = {
      id: "custom-local", name: "Home server", preset: "lmstudio", custom: true,
      configured: true, status: "connected", methods: [], capabilities: ["language"],
    };
    const other = { ...saved, id: "custom-work", name: "Work server" };
    expect(withLocalModelProviders([saved, other]).filter((provider) => provider.preset === "lmstudio")).toEqual([saved, other]);
  });

  it("retains saved configuration when its connection is no longer configured", () => {
    const saved: ProviderSummary = {
      id: "custom-disconnected", name: "Home server", preset: "ollama", custom: true,
      configured: false, status: "not_configured", methods: [], capabilities: ["language"],
    };
    const listed = withLocalModelProviders([saved]);
    expect(listed.filter((provider) => provider.preset === "ollama")).toEqual([saved]);
    expect(listed.find((provider) => provider.preset === "lmstudio")).toMatchObject({ custom: false, configured: false });
  });
});
