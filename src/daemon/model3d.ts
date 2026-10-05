import type { Model3DModel, PromptImage } from "../shared/contracts.js";

/** Every 3D model the daemon can run. Meshy T2 is the only one today; MeshyProvider calls it. */
export const MODEL_3D_MODELS: readonly Model3DModel[] = [
  { provider: "meshy", id: "meshy-t2", name: "Meshy T2", providerName: "Meshy" },
];

export function isKnownModel3D(model: unknown): boolean {
  if (!model || typeof model !== "object") return false;
  const { provider, id } = model as Record<string, unknown>;
  return MODEL_3D_MODELS.some((candidate) => candidate.provider === provider && candidate.id === id);
}

export interface Model3DGenerationInput {
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
