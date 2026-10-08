import { describe, expect, it, vi } from "vitest";
import { discoverProviderModels } from "../src/daemon/provider-model-discovery.js";

const connection = { baseUrl: "https://gateway.example/v1/", api: "openai-completions", authentication: "api_key", apiKey: "test-discovery-key" };

describe("provider model discovery", () => {
  it("reads an OpenAI-compatible list and uses reported limits and capabilities", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [
      { id: "model-a", name: "Model A", context_length: 32_000, top_provider: { max_completion_tokens: 4_000 }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["reasoning"], apiKey: connection.apiKey },
      { id: "model-b" }, { id: "bad id" }, { id: "model-b" },
      { id: "image-only", architecture: { output_modalities: ["image"] } },
    ] }));
    const result = await discoverProviderModels(connection, request);
    expect(request.mock.calls[0]?.[0].toString()).toBe("https://gateway.example/v1/models");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: `Bearer ${connection.apiKey}` }, redirect: "error" });
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ id: "model-a", name: "Model A", contextWindow: 32_000, maxTokens: 4_000, supportsImages: true, reasoning: true });
    expect(result.models[1]).toMatchObject({ id: "model-b", contextWindow: 128_000, maxTokens: 16_384 });
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
  });

  it("uses no auth header for local endpoints", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "qwen3:8b" }] }));
    await discoverProviderModels({ ...connection, baseUrl: "http://localhost:11434/v1", authentication: "none" }, request);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json" });
  });

  it("reads explicit reasoning mappings and supported effort lists, including relay ultra", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [
      { id: "mapped", thinking_level_map: { minimal: null, xhigh: "extra_high", max: "ultra" } },
      { id: "listed", supported_reasoning_efforts: ["none", "low", "high", "ultra"] },
      { id: "parameter-values", supported_parameters: { reasoning_effort: { values: ["medium", "xhigh", "max"] } } },
      { id: "disabled", reasoning: false, supported_reasoning_efforts: ["low", "high"] },
    ] }));
    const { models } = await discoverProviderModels(connection, request);
    expect(models[0]).toMatchObject({ reasoning: true, reasoningCapabilities: { source: "provider", thinkingLevelMap: { minimal: null, xhigh: "extra_high", max: "ultra" } } });
    expect(models[1]).toMatchObject({ reasoningCapabilities: { thinkingLevelMap: { off: "none", minimal: null, medium: null, xhigh: null, max: "ultra" } } });
    expect(models[2]).toMatchObject({ reasoningCapabilities: { thinkingLevelMap: { medium: "medium", xhigh: "xhigh", max: "max", off: null } } });
    expect(models[3].reasoning).toBe(false);
    expect(models.every((model) => model.thinkingLevelMap === undefined)).toBe(true);
  });

  it("paginates Anthropic models with the correct API key header", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-b" }], has_more: false }));
    const result = await discoverProviderModels({ ...connection, api: "anthropic-messages" }, request);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json", "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01" });
    expect(request.mock.calls[1]?.[0].toString()).toBe("https://gateway.example/v1/models?limit=100&after_id=claude-a");
    expect(result.models.map((model) => model.id)).toEqual(["claude-a", "claude-b"]);
    expect(result.models[0].name).toBe("Claude A");
  });

  it("normalizes Google model IDs, follows page tokens and excludes embedding models", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 100_000, outputTokenLimit: 8_000, supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] }));
    const result = await discoverProviderModels({ ...connection, api: "google-generative-ai" }, request);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-goog-api-key": connection.apiKey });
    expect(request.mock.calls[1]?.[0].toString()).toContain("pageToken=next");
    expect(result.models.map((model) => model.id)).toEqual(["gemini-a", "gemini-b"]);
    expect(result.models[0]).toMatchObject({ contextWindow: 100_000, maxTokens: 8_000 });
  });

  it("rejects invalid connections before fetching and returns usable failures without echoing remote secrets", async () => {
    const request = vi.fn<typeof fetch>();
    for (const patch of [{ baseUrl: "file:///tmp/models" }, { baseUrl: "https://user:secret@example.com" }, { api: "unknown" }, { apiKey: "" }, { api: "google-vertex" }]) await expect(discoverProviderModels({ ...connection, ...patch }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response(connection.apiKey, { status: 401 }));
    await expect(discoverProviderModels(connection, request)).rejects.toThrow("HTTP 401");
    request.mockResolvedValueOnce(Response.json({ error: connection.apiKey }));
    await expect(discoverProviderModels(connection, request)).rejects.toThrow("compatible model list");
    request.mockRejectedValueOnce(new Error(connection.apiKey));
    await expect(discoverProviderModels(connection, request)).rejects.toThrow("Could not reach the model endpoint");
  });

  it("bounds repeated and oversized catalog responses", async () => {
    const repeated = vi.fn<typeof fetch>(async () => Response.json({ data: [], has_more: true, last_id: "same" }));
    await expect(discoverProviderModels({ ...connection, api: "anthropic-messages" }, repeated)).rejects.toThrow("invalid model page");
    expect(repeated).toHaveBeenCalledTimes(2);
    const missingCursor = vi.fn<typeof fetch>(async () => Response.json({ data: [], has_more: true }));
    await expect(discoverProviderModels({ ...connection, api: "anthropic-messages" }, missingCursor)).rejects.toThrow("invalid model page");
    const oversized = vi.fn<typeof fetch>(async () => Response.json({ data: Array.from({ length: 2_100 }, (_, index) => ({ id: `model-${index}` })) }));
    const result = await discoverProviderModels(connection, oversized);
    expect(result.truncated).toBe(true);
    expect(result.models).toHaveLength(2_000);
  });
});
