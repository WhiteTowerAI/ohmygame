import type { ImageModel } from "../shared/contracts.js";
import { ImageGenerationError, openAIImageSize, type GeneratedImage, type ImageGenerationInput } from "./openai-image.js";
import { SEEDREAM_BASE_URL, seedreamRequestOptions } from "./seedream-models.js";

const REQUEST_TIMEOUT_MS = 180_000;

export class SeedreamProvider {
  constructor(
    private readonly apiKey: () => string | undefined,
    private readonly request: typeof fetch = fetch,
    private readonly baseUrl = SEEDREAM_BASE_URL,
    private readonly headers: Record<string, string> = {},
    private readonly authentication: "api_key" | "none" = "api_key",
  ) {}

  async generate(model: ImageModel, input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const key = this.apiKey();
    if (!key) throw new ImageGenerationError("Volcengine Ark API key is not configured", 503);
    if (!input.resolution || !input.aspectRatio) {
      throw new ImageGenerationError("Image resolution and aspect ratio are required for Seedream", 400);
    }
    const requestOptions = seedreamRequestOptions(model.id, input.resolution, input.aspectRatio)
      ?? (model.generationOptions.some((option) => option.resolution === input.resolution && option.aspectRatio === input.aspectRatio) ? { size: openAIImageSize(input) } : undefined);
    if (!requestOptions) throw new ImageGenerationError("Image resolution and aspect ratio are not supported by the selected model", 400);
    const images = input.images ?? [];
    if (images.length > (model.maxReferenceImages ?? 0)) {
      throw new ImageGenerationError(`The selected image model supports up to ${model.maxReferenceImages ?? 0} reference images`, 400);
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/images/generations`, {
        method: "POST",
        headers: { ...this.headers, ...(this.authentication === "none" ? {} : { authorization: `Bearer ${key}` }), "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          prompt: input.prompt,
          ...(images.length ? { image: images.map((image) => `data:${image.mediaType};base64,${image.data}`) } : {}),
          size: requestOptions.size,
          output_format: "png",
          response_format: "b64_json",
          watermark: false,
          ...(requestOptions.sequentialImageGeneration ? { sequential_image_generation: requestOptions.sequentialImageGeneration } : {}),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      throw new ImageGenerationError(cause instanceof Error && cause.name === "TimeoutError"
        ? "Seedream image generation timed out"
        : "Could not reach Volcengine Ark image generation");
    }

    const body = await response.json().catch(() => ({})) as SeedreamResponse;
    if (!response.ok || body.error) throw seedreamError(response.status, body.error);
    const result = body.data?.[0];
    if (result?.error) throw seedreamError(400, result.error);
    if (typeof result?.b64_json === "string" && result.b64_json) {
      return {
        bytes: Buffer.from(stripDataUrl(result.b64_json), "base64"),
        mediaType: imageMediaType(result.output_format),
        requestId: response.headers.get("x-request-id") ?? undefined,
      };
    }
    if (typeof result?.url === "string" && /^https?:\/\//.test(result.url)) {
      const downloaded = await this.request(result.url, { signal });
      if (!downloaded.ok) throw new ImageGenerationError(`Seedream image download failed (${downloaded.status})`, 502);
      return {
        bytes: Buffer.from(await downloaded.arrayBuffer()),
        mediaType: downloadedMediaType(downloaded.headers.get("content-type")) ?? imageMediaType(result.output_format),
        requestId: response.headers.get("x-request-id") ?? undefined,
      };
    }
    throw new ImageGenerationError("Volcengine Ark returned no generated image");
  }
}

interface SeedreamResponse {
  data?: Array<{
    b64_json?: unknown;
    url?: unknown;
    output_format?: unknown;
    error?: { code?: unknown; message?: unknown };
  }>;
  error?: { code?: unknown; message?: unknown };
}

function seedreamError(status: number, error?: { code?: unknown; message?: unknown }): ImageGenerationError {
  if (status === 401 || status === 403) return new ImageGenerationError("Volcengine Ark credentials were rejected", 503);
  if (status === 429) return new ImageGenerationError("Volcengine Ark image generation is temporarily rate limited", 429);
  const detail = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : undefined;
  return new ImageGenerationError(detail ?? "Volcengine Ark image generation failed", status >= 500 ? 502 : 400);
}

function stripDataUrl(value: string): string {
  return value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
}

function imageMediaType(format: unknown): "image/png" | "image/jpeg" {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

function downloadedMediaType(value: string | null): "image/png" | "image/jpeg" | "image/webp" | undefined {
  const type = value?.split(";", 1)[0]?.trim();
  return type === "image/png" || type === "image/jpeg" || type === "image/webp" ? type : undefined;
}
