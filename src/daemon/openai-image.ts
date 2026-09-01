import type { ImageAspectRatio, ImageResolution, ImageSize, PromptImage } from "../shared/contracts.js";

export type GeneratedImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface GeneratedImage {
  bytes: Buffer;
  mediaType: GeneratedImageMediaType;
  requestId?: string;
}

export interface ImageGenerationInput {
  prompt: string;
  size?: ImageSize;
  resolution?: ImageResolution;
  aspectRatio?: ImageAspectRatio;
  image?: PromptImage;
}

export interface ImageGenerator {
  generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<GeneratedImage>;
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

  async generate(input: ImageGenerationInput & { model?: string }, signal?: AbortSignal): Promise<GeneratedImage> {
    if (!this.apiKey) throw new ImageGenerationError("Image generation is not configured", 503);
    const endpoint = imageEndpoint(this.baseUrl, Boolean(input.image));
    const timeout = AbortSignal.timeout(130_000);
    const size = openAIImageSize(input);

    let response: Response;
    try {
      const body = input.image
        ? editForm(input, size)
        : JSON.stringify({
            model: input.model ?? "gpt-image-2",
            prompt: input.prompt,
            size,
            quality: "medium",
            output_format: "webp",
            n: 1,
          });
      response = await this.request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(!input.image ? { "content-type": "application/json" } : {}),
        },
        body,
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
      data?: Array<{ b64_json?: unknown; url?: unknown }>;
      error?: { code?: unknown; message?: unknown };
    };
    if (!response.ok) throw openAIError(response.status, body.error);
    const result = body.data?.[0];
    const encoded = result?.b64_json;
    if (typeof encoded === "string" && encoded) {
      return {
        bytes: Buffer.from(encoded, "base64"),
        mediaType: "image/webp",
        requestId: response.headers.get("x-request-id") ?? undefined,
      };
    }
    if (typeof result?.url === "string" && result.url) return this.downloadImage(result.url, signal, response.headers.get("x-request-id"));
    throw new ImageGenerationError("OpenAI returned no generated image");
  }

  private async downloadImage(url: string, signal: AbortSignal | undefined, requestId: string | null): Promise<GeneratedImage> {
    let imageResponse: Response;
    try {
      const timeout = AbortSignal.timeout(30_000);
      imageResponse = await this.request(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      throw new ImageGenerationError("Could not download the generated image");
    }
    if (!imageResponse.ok) throw new ImageGenerationError("Could not download the generated image");
    return {
      bytes: Buffer.from(await imageResponse.arrayBuffer()),
      mediaType: contentType(imageResponse.headers.get("content-type")) ?? "image/webp",
      requestId: requestId ?? undefined,
    };
  }
}

function contentType(value: string | null): GeneratedImageMediaType | undefined {
  const type = value?.split(";", 1)[0]?.trim();
  return type === "image/png" || type === "image/jpeg" || type === "image/webp" ? type : undefined;
}

function imageEndpoint(baseUrl: string, edit: boolean): string {
  try {
    const url = new URL(baseUrl);
    if (url.search || url.hash) throw new Error("Unexpected URL components");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/images/${edit ? "edits" : "generations"}`;
    return url.toString();
  } catch {
    throw new ImageGenerationError("OpenAI base URL is not valid", 503);
  }
}

function openAIImageSize(input: ImageGenerationInput): ImageSize {
  if (input.size) return input.size;
  if (input.resolution !== "1K") throw new ImageGenerationError("Image resolution is not supported by the selected model", 400);
  if (input.aspectRatio === "1:1") return "1024x1024";
  if (input.aspectRatio === "3:2") return "1536x1024";
  throw new ImageGenerationError("Image aspect ratio is not supported by the selected model", 400);
}

function editForm(input: ImageGenerationInput & { model?: string }, size: ImageSize): FormData {
  const image = input.image;
  if (!image) throw new ImageGenerationError("A reference image is required", 400);
  const form = new FormData();
  form.set("model", input.model ?? "gpt-image-2");
  form.set("prompt", input.prompt);
  form.set("size", size);
  form.set("quality", "medium");
  form.set("output_format", "webp");
  form.set("n", "1");
  const extension = image.mediaType === "image/png" ? "png" : image.mediaType === "image/jpeg" ? "jpg" : "webp";
  form.set("image", new Blob([Buffer.from(image.data, "base64")], { type: image.mediaType }), `reference.${extension}`);
  return form;
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
