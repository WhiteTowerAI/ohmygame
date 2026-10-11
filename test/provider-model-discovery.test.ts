import { describe, expect, it, vi } from "vitest";
import { discoverProviderModels } from "../src/daemon/provider-model-discovery.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";

const connection = { baseUrl: "https://gateway.example/v1/", api: "openai-completions", authentication: "api_key", apiKey: "test-discovery-key" };

describe("provider model discovery", () => {
  it.each(["meshy", "tripo", "hyper3d"] as const)("loads official %s presets without probing a LLM endpoint or claiming key access", async (preset) => {
    const request = vi.fn<typeof fetch>();
    const result = await discoverProviderModels({ ...connection, preset, baseUrl: { meshy: "https://api.meshy.ai/openapi/v1", tripo: "https://openapi.tripo3d.ai/v3", hyper3d: "https://api.hyper3d.com/api/v2" }[preset] }, request);
    expect(result.source).toBe("presets");
    expect(result.models).toHaveLength(MODEL_3D_PRESETS[preset].length);
    expect(result.models.every((model) => model.usages?.["3d"]?.protocol === preset && !model.usages?.language)).toBe(true);
    expect(result.models[1]?.usages?.["3d"]?.maxReferenceImages).toBe(preset === "hyper3d" ? 5 : 4);
    expect(result.warnings?.[0]).toContain("does not check API-key access");
    expect(request).not.toHaveBeenCalled();
  });

  it("discovers versions from compatible 3D relays and uses known templates for official IDs", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "meshy-7.1" }, { id: "relay-future" }] }));
    const result = await discoverProviderModels({ ...connection, preset: "meshy" }, request);
    expect(request.mock.calls[0]?.[0].toString()).toBe("https://gateway.example/v1/models");
    expect(result.models[0]?.usages?.["3d"]).toMatchObject({ operation: "multi-image-to-3d", maxReferenceImages: 4 });
    expect(result.models[1]?.usages?.["3d"]?.protocol).toBe("meshy");
  });
  it("reads an OpenAI-compatible list and uses reported limits and capabilities", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [
      { id: "model-a", name: "Model A", context_length: 32_000, top_provider: { max_completion_tokens: 4_000 }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["reasoning"], apiKey: connection.apiKey },
      { id: "model-b" }, { id: "bad id" }, { id: "model-b" },
      { id: "image-only", architecture: { output_modalities: ["image"] } },
    ] }));
    const result = await discoverProviderModels(connection, request);
    expect(request.mock.calls[0]?.[0].toString()).toBe("https://gateway.example/v1/models");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: `Bearer ${connection.apiKey}` }, redirect: "error" });
    expect(result.models).toHaveLength(3);
    expect(result.models[1].usages).toEqual({});
    expect(result.models[2].usages?.image?.protocol).toBe("openai-images");
    expect(result.models[0]).toMatchObject({ id: "model-a", name: "Model A", contextWindow: 32_000, maxTokens: 4_000, supportsImages: true, reasoning: true });
    expect(result.models[1]).toMatchObject({ id: "model-b", contextWindow: 128_000, maxTokens: 16_384 });
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
  });

  it("uses no auth header for local endpoints", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "qwen3:8b" }] }));
    await discoverProviderModels({ ...connection, baseUrl: "http://localhost:11434/v1", authentication: "none" }, request);
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json" });
  });

  it("merges dedicated media catalogs by ID and keeps every declared use and limit", async () => {
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/images/models")) return Response.json({ data: [{
        id: "shared-alias", architecture: { input_modalities: ["image"], output_modalities: ["image"] },
        supported_parameters: { resolution: { type: "enum", values: ["1K", "2K"] }, aspect_ratio: { type: "enum", values: ["1:1", "16:9"] }, input_references: { type: "range", max: 20 }, n: { type: "range", max: 4 } },
      }] });
      if (path.endsWith("/videos/models")) return Response.json({ data: [{
        id: "shared-alias", supported_resolutions: ["720p"], supported_aspect_ratios: ["16:9"], supported_durations: [5, 10], supported_frame_images: ["first", "last"],
      }, { id: "video-alias", description: "reference images", supported_resolutions: ["1080p"], supported_aspect_ratios: ["9:16"], supported_durations: [6] }] });
      return Response.json({ data: [{ id: "shared-alias", name: "Multimodal", architecture: { output_modalities: ["text"] } }, { id: "unknown-alias" }] });
    });
    const result = await discoverProviderModels({ ...connection, preset: "openrouter" }, request);
    expect(result.warnings).toBeUndefined();
    expect(result.models).toHaveLength(3);
    expect(result.models.find((model) => model.id === "shared-alias")).toMatchObject({ name: "Multimodal", usages: {
      language: true,
      image: { protocol: "openrouter-images", resolutions: ["1K", "2K"], aspectRatios: ["1:1", "16:9"], maxReferenceImages: 14, maxOutputs: 4 },
      video: { protocol: "openrouter-videos", resolutions: ["720p"], durations: [5, 10], maxReferenceImages: 2, referenceModes: ["frame"] },
    } });
    expect(result.models.find((model) => model.id === "video-alias")?.usages?.video).toMatchObject({ maxReferenceImages: 9, referenceModes: ["reference"] });
    expect(result.models.find((model) => model.id === "unknown-alias")?.usages).toEqual({});
    expect(request.mock.calls).toHaveLength(3);
    expect(request.mock.calls.every(([, options]) => new Headers(options?.headers).get("authorization") === `Bearer ${connection.apiKey}`)).toBe(true);
  });

  it("keeps successful catalogs when dedicated discovery fails and respects no-key authentication", async () => {
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/images/models")) return new Response(connection.apiKey, { status: 503 });
      if (path.endsWith("/videos/models")) return Response.json({ data: [{ id: "video-only", supported_resolutions: ["720p"], supported_aspect_ratios: ["16:9"], supported_durations: [5] }] });
      return Response.json({ data: [{ id: "chat", architecture: { output_modalities: ["text"] } }] });
    });
    const result = await discoverProviderModels({ ...connection, preset: "openrouter", authentication: "none", apiKey: undefined }, request);
    expect(result.models.map((model) => model.id)).toEqual(["chat", "video-only"]);
    expect(result.warnings).toEqual(["Could not fetch image models. Add their IDs manually."]);
    expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    expect(request.mock.calls.every(([, options]) => !new Headers(options?.headers).has("authorization"))).toBe(true);
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

  it("normalizes Google model IDs, follows page tokens and leaves embedding models unassigned", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-a", displayName: "Gemini A", inputTokenLimit: 100_000, outputTokenLimit: 8_000, supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] }));
    const result = await discoverProviderModels({ ...connection, api: "google-generative-ai" }, request);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-goog-api-key": connection.apiKey });
    expect(request.mock.calls[1]?.[0].toString()).toContain("pageToken=next");
    expect(result.models.map((model) => model.id)).toEqual(["gemini-a", "embedding", "gemini-b"]);
    expect(result.models[1].usages).toEqual({});
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
