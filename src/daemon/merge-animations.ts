import { NodeIO, type Accessor, type Animation, type Buffer as GltfBuffer, type Document, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Model3DGenerationError } from "./model3d.js";

/**
 * Folds the clips of several animated GLBs into the first one. Every file must share one skeleton, as Meshy's
 * animation results do when they come from the same rig task; channels are matched to bones by name.
 */
export async function mergeAnimationClips(files: Buffer[]): Promise<Buffer> {
  const [first, ...rest] = files;
  if (!first) throw new Model3DGenerationError("No animated models to merge");
  if (rest.length === 0) return first;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const target = await io.readBinary(first);
  const root = target.getRoot();
  const buffer = root.listBuffers()[0] ?? target.createBuffer();
  const bones = new Map(root.listNodes().map((node) => [node.getName(), node]));
  const clipNames = new Set(root.listAnimations().map((animation) => animation.getName()));
  for (const file of rest) {
    for (const source of (await io.readBinary(file)).getRoot().listAnimations()) {
      copyAnimation(target, source, buffer, bones, uniqueName(source.getName(), clipNames));
    }
  }
  return Buffer.from(await io.writeBinary(target));
}

function copyAnimation(target: Document, source: Animation, buffer: GltfBuffer, bones: Map<string, Node>, name: string): void {
  // Samplers usually share one keyframe-time accessor; copying it once keeps the file from growing per channel.
  const copies = new Map<Accessor, Accessor>();
  const copy = (accessor: Accessor | null) => {
    if (!accessor) throw new Model3DGenerationError("Meshy returned an animation without keyframes");
    let copied = copies.get(accessor);
    if (!copied) {
      copied = target.createAccessor()
        .setType(accessor.getType())
        .setArray(accessor.getArray()!.slice())
        .setNormalized(accessor.getNormalized())
        .setBuffer(buffer);
      copies.set(accessor, copied);
    }
    return copied;
  };
  const animation = target.createAnimation(name);
  for (const channel of source.listChannels()) {
    const sourceSampler = channel.getSampler();
    const bone = bones.get(channel.getTargetNode()?.getName() ?? "");
    const path = channel.getTargetPath();
    if (!sourceSampler || !bone || !path) throw new Model3DGenerationError("Meshy returned animations for different skeletons");
    const sampler = target.createAnimationSampler()
      .setInterpolation(sourceSampler.getInterpolation())
      .setInput(copy(sourceSampler.getInput()))
      .setOutput(copy(sourceSampler.getOutput()));
    animation.addSampler(sampler).addChannel(target.createAnimationChannel()
      .setTargetNode(bone)
      .setTargetPath(path)
      .setSampler(sampler));
  }
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${name}_${suffix}`;
  taken.add(candidate);
  return candidate;
}
