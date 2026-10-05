import type { Model3DModelRef, PromptImage } from "../shared/contracts.js";

export interface Model3DGenerationInput {
  model: Model3DModelRef;
  images: PromptImage[];
  targetPolycount?: number;
  texture?: boolean;
  pbr?: boolean;
}

export interface Generated3DModel {
  bytes: Buffer;
  mediaType: "model/gltf-binary";
  requestId?: string;
}

export interface Model3DGenerator {
  generate(input: Model3DGenerationInput, signal?: AbortSignal): Promise<Generated3DModel>;
}

export class Model3DGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}
