import type { ImageSize } from "../shared/contracts.js";

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: "image/webp";
  requestId?: string;
}

export interface ImageGenerator {
  generate(input: { prompt: string; size: ImageSize }, signal?: AbortSignal): Promise<GeneratedImage>;
}

export interface ImageGeneratorConfig {
  apiKey?: string;
  apiUrl: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ImageGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

export class OpenAIImageGenerator implements ImageGenerator {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly request: Fetch = fetch,
  ) {}

  async generate(input: { prompt: string; size: ImageSize }, signal?: AbortSignal): Promise<GeneratedImage> {
    if (!this.apiKey) throw new ImageGenerationError("Image generation is not configured", 503);
    const endpoint = imageEndpoint(this.baseUrl);
    const timeout = AbortSignal.timeout(130_000);

    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: input.prompt,
          size: input.size,
          quality: "medium",
          output_format: "webp",
          n: 1,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      const message = cause instanceof Error && cause.name === "TimeoutError"
        ? "Image generation timed out"
        : "Could not reach OpenAI image generation";
      throw new ImageGenerationError(message);
    }

    const body = await response.json().catch(() => ({})) as {
      data?: Array<{ b64_json?: unknown }>;
      error?: { code?: unknown; message?: unknown };
    };
    if (!response.ok) throw openAIError(response.status, body.error);
    const encoded = body.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || !encoded) {
      throw new ImageGenerationError("OpenAI returned no generated image");
    }
    return {
      bytes: Buffer.from(encoded, "base64"),
      mediaType: "image/webp",
      requestId: response.headers.get("x-request-id") ?? undefined,
    };
  }
}

export class ConfiguredImageGenerator implements ImageGenerator {
  constructor(
    private readonly configuration: () => ImageGeneratorConfig,
    private readonly request: Fetch = fetch,
  ) {}

  generate(input: { prompt: string; size: ImageSize }, signal?: AbortSignal): Promise<GeneratedImage> {
    const configuration = this.configuration();
    return new OpenAIImageGenerator(configuration.apiKey, configuration.apiUrl, this.request).generate(input, signal);
  }
}

function imageEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.search || url.hash) throw new Error("Unexpected URL components");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/images/generations`;
    return url.toString();
  } catch {
    throw new ImageGenerationError("OpenAI base URL is not valid", 503);
  }
}

function openAIError(status: number, error?: { code?: unknown; message?: unknown }): ImageGenerationError {
  if (status === 401 || status === 403) {
    return new ImageGenerationError("OpenAI API key was rejected", 503);
  }
  if (status === 429) {
    return new ImageGenerationError("OpenAI image generation is temporarily rate limited", 429);
  }
  if (error?.code === "moderation_blocked") {
    return new ImageGenerationError("The image request did not meet safety requirements", 400);
  }
  if (status >= 400 && status < 500) {
    const message = typeof error?.message === "string" && error.message
      ? error.message
      : "OpenAI rejected the image request";
    return new ImageGenerationError(message, 400);
  }
  return new ImageGenerationError("OpenAI image generation failed");
}
