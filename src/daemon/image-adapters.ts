import type { ImageProtocol } from "../shared/contracts.js";
import { ImageGenerationError, OpenAIImageGenerator, type GeneratedImage, type GeneratedImageMediaType, type ImageGenerationInput } from "./openai-image.js";

export interface ImageSource {
  baseUrl: string;
  apiKey: string;
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
  };
}

async function generateGemini(source: ImageSource, model: string, input: ImageGenerationInput, signal: AbortSignal | undefined, request: Fetch): Promise<GeneratedImage> {
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
          ...(input.image ? [{ inlineData: { mimeType: input.image.mediaType, data: input.image.data } }] : []),
        ] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: input.aspectRatio ?? aspectRatio(input.size) } },
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
