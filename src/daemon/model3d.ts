import type { Model3DAnimationAction, Model3DModel, Model3DModelRef, PromptImage } from "../shared/contracts.js";

export type { Model3DAnimationAction };

export interface Model3DGenerationInput {
  model: Model3DModelRef;
  images: PromptImage[];
  targetPolycount?: number;
  texture?: boolean;
  pbr?: boolean;
}

export interface Model3DAnimationInput {
  /** A textured humanoid GLB. */
  model: Buffer;
  actionIds: number[];
  heightMeters?: number;
}

export interface Generated3DModel {
  bytes: Buffer;
  mediaType: "model/gltf-binary";
  requestId?: string;
}

export interface Model3DGenerator {
  generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel>;
  /** Rigging and animation; providers without it cannot animate models. */
  animate?(input: Model3DAnimationInput, signal?: AbortSignal): Promise<Generated3DModel>;
  animations?(signal?: AbortSignal): Promise<Model3DAnimationAction[]>;
  resolveModel?(model?: Model3DModelRef): Promise<Model3DModel | undefined>;
}

export class Model3DGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

/** Bound downloaded artifacts while streaming, before allocating a complete GLB. */
export async function readModel3DResult(response: Response): Promise<Buffer> {
  const maximum = 100 * 1024 * 1024;
  if (!response.body) throw new Model3DGenerationError("Generated model download is empty");
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel().catch(() => {});
    throw new Model3DGenerationError("Generated model is too large", 413);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Model3DGenerationError("Generated model is too large", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size) throw new Model3DGenerationError("Generated model download is empty");
  return Buffer.concat(chunks);
}
