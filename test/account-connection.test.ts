import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AccountConnection, accountModels } from "../src/daemon/account-connection.js";
import type { AccountServiceClient } from "../src/daemon/account-service-client.js";

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

describe("accountModels", () => {
  it("uses account availability with Pi capability metadata", () => {
    expect(accountModels([knownModel] as never, ["known-model", "unknown-model"])).toEqual([{
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

    expect(accountModels([alternate, knownModel] as never, ["known-model"]))
      .toMatchObject([{ id: "known-model", contextWindow: 100_000 }]);
  });

  it("uses a non-OpenAI definition when all matching providers agree", () => {
    const anthropic = { ...knownModel, provider: "anthropic", id: "claude-known" };
    const gateway = { ...anthropic, provider: "cloudflare-ai-gateway" };

    expect(accountModels([anthropic, gateway] as never, ["claude-known"]))
      .toMatchObject([{ id: "claude-known", contextWindow: 100_000 }]);
  });

  it("excludes image-generation model IDs", () => {
    const image = { ...knownModel, id: "gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite" };
    const preview = { ...knownModel, id: "google/gemini-3-pro-image-preview", name: "Nano Banana Pro" };

    expect(accountModels([knownModel, image, preview] as never, [knownModel.id, image.id, preview.id]))
      .toMatchObject([{ id: "known-model" }]);
  });
});

describe("AccountConnection", () => {
  it("registers a memory-only provider and removes it on disconnect", async () => {
    const runtime = runtimeMock();
    const client = {
      credential: vi.fn(async () => ({ baseUrl: "https://account.ohmygame.ai/v1", apiKey: "sk-account" })),
      modelIds: vi.fn(async () => ["known-model", "meshy-7", "meshy-t2"]),
      stageMedia: vi.fn(async () => ({ id: "media", url: "https://storage.example/media" })),
      removeMedia: vi.fn(async () => undefined),
    } as unknown as AccountServiceClient;
    const connection = new AccountConnection(async () => runtime, client);

    await expect(connection.connect("supabase-token")).resolves.toEqual({ status: "connected", modelCount: 1 });
    expect(connection.imageSource()).toEqual({
      baseUrl: "https://account.ohmygame.ai/v1",
      apiKey: "sk-account",
      modelIds: ["known-model", "meshy-7", "meshy-t2"],
    });
    expect(connection.model3DSource()).toEqual(connection.imageSource());
    expect(runtime.registerProvider).toHaveBeenCalledWith("ohmygame", expect.objectContaining({
      baseUrl: "https://account.ohmygame.ai/v1",
      api: "openai-responses",
    }));
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("ohmygame", "sk-account");
    const videoSource = connection.videoSource();
    await expect(videoSource?.stageMedia({ type: "image", name: "image.png", mediaType: "image/png", absolutePath: "/image.png" }))
      .resolves.toEqual({ id: "media", url: "https://storage.example/media" });
    expect(client.stageMedia).toHaveBeenCalledWith("supabase-token", expect.objectContaining({ name: "image.png" }), undefined);

    await connection.disconnect();
    expect(connection.imageSource()).toBeUndefined();
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("ohmygame");
    expect(runtime.unregisterProvider).toHaveBeenCalledWith("ohmygame");
  });

  it("connects without registering a Pi provider when account service has no supported agent models", async () => {
    const runtime = runtimeMock();
    const client = {
      credential: vi.fn(async () => ({ baseUrl: "https://account.ohmygame.ai/v1", apiKey: "sk-account" })),
      modelIds: vi.fn(async () => ["unknown-model"]),
    } as unknown as AccountServiceClient;
    const connection = new AccountConnection(async () => runtime, client);

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
