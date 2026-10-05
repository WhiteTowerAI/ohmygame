import type { Model3DAnimationAction, Model3DModelRef, PromptImage } from "../shared/contracts.js";

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
}

export class Model3DGenerationError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}
