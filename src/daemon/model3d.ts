import type {
  Model3DModel,
  Model3DPose,
  Model3DQuality,
  Model3DTextureResolution,
  PromptImage,
} from "../shared/contracts.js";

interface Model3DGenerationOptions {
  model?: Model3DModel;
  quality?: Model3DQuality;
  targetPolycount?: number;
  texture?: boolean;
  textureResolution?: Model3DTextureResolution;
  pbr?: boolean;
  pose?: Model3DPose;
}

export type Text3DGenerationInput = Model3DGenerationOptions & {
  prompt: string;
  images?: never;
  imageEnhancement?: never;
};

export type Image3DGenerationInput = Model3DGenerationOptions & {
  prompt?: never;
  images: PromptImage[];
  imageEnhancement?: boolean;
};

export type Model3DGenerationInput = Text3DGenerationInput | Image3DGenerationInput;

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
