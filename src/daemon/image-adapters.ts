import type { ImageProtocol } from "../shared/contracts.js";
import { withOpenRouterAttribution } from "./openrouter-attribution.js";
import { ImageGenerationError, OpenAIImageGenerator, type GeneratedImage, type GeneratedImageMediaType, type ImageGenerationInput } from "./openai-image.js";

export interface ImageSource {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface ImageProtocolAdapter {
  generate(source: ImageSource, model: string, input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createImageProtocolAdapters(request: Fetch = fetch): Record<ImageProtocol, ImageProtocolAdapter> {
  return {
    "openai-images": {
      generate: (source, model, input, signal) => new OpenAIImageGenerator(source.apiKey, source.baseUrl, request).generate({ ...input, model }, signal),
    },
    "gemini-generate-content": {
      generate: (source, model, input, signal) => generateGemini(source, model, input, signal, request),
    },
    "openrouter-images": {
      generate: (source, model, input, signal) => generateOpenRouter(source, model, input, signal, request),
    },
  };
}

async function generateOpenRouter(source: ImageSource, model: string, input: ImageGenerationInput, signal: AbortSignal | undefined, request: Fetch): Promise<GeneratedImage> {
  const timeout = AbortSignal.timeout(180_000);
  let response: Response;
  try {
    response = await request(`${source.baseUrl.replace(/\/$/, "")}/images`, {
      method: "POST",
      headers: { ...withOpenRouterAttribution(source.headers ?? {}), authorization: `Bearer ${source.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        ...(input.images?.length ? {
          input_references: input.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mediaType};base64,${image.data}` },
          })),
        } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    throw new ImageGenerationError(cause instanceof Error && cause.name === "TimeoutError" ? "Image generation timed out" : "Could not reach OpenRouter image generation");
  }
  const body = await response.json().catch(() => ({})) as {
    error?: { message?: unknown };
    data?: Array<{ b64_json?: unknown; url?: unknown; media_type?: unknown }>;
  };
  if (!response.ok) throw openRouterImageError(response.status, body.error?.message);
  const result = body.data?.[0];
  if (!result) throw new ImageGenerationError("OpenRouter returned no generated image");
  const mediaType = imageMediaType(result.media_type) ?? "image/png";
  if (typeof result.b64_json === "string" && result.b64_json) {
    return { bytes: Buffer.from(result.b64_json, "base64"), mediaType, requestId: response.headers.get("x-request-id") ?? undefined };
  }
  if (typeof result.url === "string" && /^https?:\/\//.test(result.url)) {
    const imageResponse = await request(result.url, { signal });
    if (!imageResponse.ok) throw new ImageGenerationError("Could not download the generated image");
    const downloadedType = imageMediaType(imageResponse.headers.get("content-type")) ?? mediaType;
    return { bytes: Buffer.from(await imageResponse.arrayBuffer()), mediaType: downloadedType, requestId: response.headers.get("x-request-id") ?? undefined };
  }
  throw new ImageGenerationError("OpenRouter returned no generated image");
}

async function generateGemini(source: ImageSource, model: string, input: ImageGenerationInput, signal: AbortSignal | undefined, request: Fetch): Promise<GeneratedImage> {
  const images = input.images ?? [];
  const endpoint = geminiEndpoint(source.baseUrl, model);
  const timeout = AbortSignal.timeout(130_000);
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${source.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: input.prompt },
          ...images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })),
        ] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: input.aspectRatio ?? aspectRatio(input.size),
            ...(input.resolution ? { imageSize: input.resolution } : {}),
          },
        },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    throw new ImageGenerationError(cause instanceof Error && cause.name === "TimeoutError" ? "Image generation timed out" : "Could not reach Gemini image generation");
  }
  const body = await response.json().catch(() => ({})) as GeminiResponse;
  if (!response.ok) throw new ImageGenerationError(geminiError(response.status, body), geminiStatusCode(response.status));
  const inlineData = body.candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.inlineData).find((data) => typeof data?.data === "string" && data.data);
  if (typeof inlineData?.data !== "string" || !inlineData.data) throw new ImageGenerationError("Gemini returned no generated image");
  const mediaType = imageMediaType(inlineData.mimeType);
  if (!mediaType) throw new ImageGenerationError("Gemini returned an unsupported image format");
  return { bytes: Buffer.from(inlineData.data, "base64"), mediaType, requestId: body.responseId ?? response.headers.get("x-request-id") ?? undefined };
}

interface GeminiResponse {
  responseId?: string;
  error?: { message?: unknown };
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown; mimeType?: unknown } }> } }>;
}

function geminiEndpoint(baseUrl: string, model: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.search || url.hash) throw new Error();
    const pathname = url.pathname.replace(/\/$/, "");
    url.pathname = `${pathname.endsWith("/v1") ? `${pathname}beta` : pathname.endsWith("/v1beta") ? pathname : `${pathname}/v1beta`}/models/${encodeURIComponent(model)}:generateContent`;
    return url.toString();
  } catch {
    throw new ImageGenerationError("Gemini base URL is not valid", 503);
  }
}

function imageMediaType(value: unknown): GeneratedImageMediaType | undefined {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" ? value : undefined;
}

function aspectRatio(size?: ImageGenerationInput["size"]): "1:1" | "16:9" | "9:16" {
  if (size === "1536x1024") return "16:9";
  if (size === "1024x1536") return "9:16";
  return "1:1";
}

function geminiError(status: number, body: GeminiResponse): string {
  if (status === 401 || status === 403) return "Gemini API key was rejected";
  if (status === 429) return "Gemini image generation is temporarily rate limited";
  return typeof body.error?.message === "string" && body.error.message ? body.error.message : "Gemini image generation failed";
}

function geminiStatusCode(status: number): number {
  if (status === 401 || status === 403) return 503;
  if (status === 429) return 429;
  return status >= 500 ? 502 : 400;
}

function openRouterImageError(status: number, message: unknown): ImageGenerationError {
  const detail = typeof message === "string" && message.trim() ? message : undefined;
  if (status === 401 || status === 403) return new ImageGenerationError("OpenRouter credentials were rejected", 503);
  if (status === 429) return new ImageGenerationError("OpenRouter image generation is temporarily rate limited", 429);
  return new ImageGenerationError(detail ?? "OpenRouter image generation failed", status >= 500 ? 502 : 400);
}
