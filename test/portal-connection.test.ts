import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PortalConnection, portalModels } from "../src/daemon/portal-connection.js";
import type { PortalClient } from "../src/daemon/portal-client.js";

const knownModel = {
  provider: "openai",
  id: "known-model",
  name: "Known Model",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as const;

describe("portalModels", () => {
  it("uses Portal availability with Pi capability metadata", () => {
    expect(portalModels([knownModel] as never, ["known-model", "unknown-model"])).toEqual([{
      id: "known-model",
      name: "Known Model",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 10_000,
    }]);
  });

  it("uses OpenAI metadata when another provider defines the same model differently", () => {
    const alternate = { ...knownModel, provider: "azure-openai-responses", contextWindow: 1_000_000 };

    expect(portalModels([alternate, knownModel] as never, ["known-model"]))
      .toMatchObject([{ id: "known-model", contextWindow: 100_000 }]);
  });

  it("uses a non-OpenAI definition when all matching providers agree", () => {
    const anthropic = { ...knownModel, provider: "anthropic", id: "claude-known" };
    const gateway = { ...anthropic, provider: "cloudflare-ai-gateway" };

    expect(portalModels([anthropic, gateway] as never, ["claude-known"]))
      .toMatchObject([{ id: "claude-known", contextWindow: 100_000 }]);
  });
});

describe("PortalConnection", () => {
  it("registers a memory-only provider and removes it on disconnect", async () => {
    const runtime = runtimeMock();
    const client = {
      credential: vi.fn(async () => ({ baseUrl: "https://portal.open-game.ai/v1", apiKey: "sk-portal" })),
      modelIds: vi.fn(async () => ["known-model"]),
    } as unknown as PortalClient;
    const connection = new PortalConnection(async () => runtime, client);

    await expect(connection.connect("supabase-token")).resolves.toEqual({ status: "connected", modelCount: 1 });
    expect(connection.imageSource()).toEqual({
      baseUrl: "https://portal.open-game.ai/v1",
      apiKey: "sk-portal",
      modelIds: ["known-model"],
    });
    expect(runtime.registerProvider).toHaveBeenCalledWith("opengame", expect.objectContaining({
      baseUrl: "https://portal.open-game.ai/v1",
      api: "openai-responses",
    }));
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("opengame", "sk-portal");

    await connection.disconnect();
    expect(connection.imageSource()).toBeUndefined();
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("opengame");
    expect(runtime.unregisterProvider).toHaveBeenCalledWith("opengame");
  });

  it("connects without registering a Pi provider when Portal has no supported agent models", async () => {
    const runtime = runtimeMock();
    const client = {
      credential: vi.fn(async () => ({ baseUrl: "https://portal.open-game.ai/v1", apiKey: "sk-portal" })),
      modelIds: vi.fn(async () => ["unknown-model"]),
    } as unknown as PortalClient;
    const connection = new PortalConnection(async () => runtime, client);

    await expect(connection.connect("supabase-token")).resolves.toEqual({ status: "connected", modelCount: 0 });
    expect(runtime.registerProvider).not.toHaveBeenCalled();
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });
});

function runtimeMock() {
  return {
    getModels: vi.fn(() => [knownModel]),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(async () => undefined),
    removeRuntimeApiKey: vi.fn(async () => undefined),
  } as unknown as ModelRuntime & {
    registerProvider: ReturnType<typeof vi.fn>;
    unregisterProvider: ReturnType<typeof vi.fn>;
    setRuntimeApiKey: ReturnType<typeof vi.fn>;
    removeRuntimeApiKey: ReturnType<typeof vi.fn>;
  };
}
