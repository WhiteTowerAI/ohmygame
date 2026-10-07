import type { AssetCanvasReference, VideoModel, VideoReferenceMode } from "./contracts.js";

export type VideoReferenceMentions = Record<string, AssetCanvasReference>;
const mentionPattern = /@(Image[1-9][0-9]*)(?![\w])/g;

export function sameVideoReference(left: AssetCanvasReference, right: AssetCanvasReference): boolean {
  return left.type === "node" && right.type === "node" ? left.nodeId === right.nodeId
    : left.type === "library" && right.type === "library" && left.assetId === right.assetId;
}

/** Keep aliases reserved after removal so an old mention can never target a new image. */
export function videoReferenceAliases(references: readonly AssetCanvasReference[], saved: VideoReferenceMentions = {}): VideoReferenceMentions {
  const aliases = { ...saved };
  let next = Math.max(0, ...Object.keys(aliases).map((key) => Number(key.slice(5)) || 0)) + 1;
  for (const reference of references) {
    if (!Object.values(aliases).some((existing) => sameVideoReference(existing, reference))) aliases[`Image${next++}`] = reference;
  }
  return aliases;
}

/** Resolve stable UI aliases into the order actually submitted to the provider. */
export function resolveVideoMentions(prompt: string, references: readonly AssetCanvasReference[], saved: VideoReferenceMentions = {}): string {
  const aliases = videoReferenceAliases(references, saved);
  return prompt.replace(mentionPattern, (_, alias: string) => {
    const reference = aliases[alias];
    const index = reference ? references.findIndex((candidate) => sameVideoReference(reference, candidate)) : -1;
    if (index < 0) throw new Error(`@${alias} refers to a missing image. Remove the mention or add the image again.`);
    return `Image ${index + 1}`;
  });
}

export function videoReferenceMode(model: VideoModel | undefined, requested?: VideoReferenceMode): VideoReferenceMode {
  // Boards saved before mode selection existed used first/last frames.
  return model?.referenceModes?.length ? requested ?? "frame" : model?.imageReferenceMode ?? "frame";
}

export function videoReferenceLimit(model: VideoModel | undefined, requested?: VideoReferenceMode): number {
  return videoReferenceMode(model, requested) === "frame" ? Math.min(2, model?.maxImageReferences ?? 0) : model?.maxImageReferences ?? 0;
}

export function videoReferenceAspectRatios(model: VideoModel | undefined, count: number, requested?: VideoReferenceMode) {
  if (count > 0) {
    if (videoReferenceMode(model, requested) === "frame" && model?.frameAspectRatios?.length) return model.frameAspectRatios;
    if (model?.imageAspectRatios?.length) return model.imageAspectRatios;
  }
  return model?.aspectRatios ?? [];
}
