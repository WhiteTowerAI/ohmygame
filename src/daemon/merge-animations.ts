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
  const bones = uniqueNodes(target);
  const clipNames = new Set(root.listAnimations().map((animation) => animation.getName()));
  for (const file of rest) {
    const document = await io.readBinary(file);
    validateSkeleton(target, document, bones);
    for (const source of document.getRoot().listAnimations()) {
      copyAnimation(target, source, buffer, bones, uniqueName(source.getName(), clipNames));
    }
  }
  return Buffer.from(await io.writeBinary(target));
}

/** Ambiguous names cannot be used as cross-file channel identities. */
function uniqueNodes(document: Document): Map<string, Node> {
  const nodes = new Map<string, Node>(), duplicates = new Set<string>();
  for (const node of document.getRoot().listNodes()) {
    const name = node.getName();
    if (!name) continue;
    if (nodes.has(name)) duplicates.add(name);
    nodes.set(name, node);
  }
  for (const name of duplicates) nodes.delete(name);
  return nodes;
}

function validateSkeleton(target: Document, source: Document, bones: Map<string, Node>): void {
  const fail = (): never => { throw new Model3DGenerationError("Animation results have incompatible skeletons"); };
  const sources = uniqueNodes(source);
  const equal = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length
    && Array.from(a).every((value, i) => Number.isFinite(value) && Number.isFinite(b[i]) && Math.abs(value - b[i]!) <= 1e-5);
  const parents = (node: Node): string[] => {
    const names: string[] = [];
    for (let parent = node.getParentNode(); parent; parent = parent.getParentNode()) names.push(parent.getName());
    return names;
  };
  const match = (node: Node) => {
    const name = node.getName(), bone = bones.get(name);
    if (!bone || sources.get(name) !== node || JSON.stringify(parents(node)) !== JSON.stringify(parents(bone))
      || !equal(node.getMatrix(), bone.getMatrix()) || !equal(node.getWorldMatrix(), bone.getWorldMatrix())) fail();
  };
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const bindings = (document: Document) => document.getRoot().listSkins().map(skin => skin.listJoints().map((joint, index) => ({
    name: joint.getName(), matrix: skin.getInverseBindMatrices()?.getElement(index, []) ?? identity,
  })).sort((a, b) => a.name.localeCompare(b.name))).sort((a, b) => JSON.stringify(a.map(joint => joint.name)).localeCompare(JSON.stringify(b.map(joint => joint.name))));
  const a = bindings(target), b = bindings(source);
  if (a.length !== b.length || a.some((skin, i) => skin.length !== b[i]!.length || skin.some((joint, j) => joint.name !== b[i]![j]!.name || !equal(joint.matrix, b[i]![j]!.matrix)))) fail();
  for (const skin of source.getRoot().listSkins()) for (const joint of skin.listJoints()) match(joint);
  for (const animation of source.getRoot().listAnimations()) for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode();
    if (!node) fail();
    match(node!);
  }
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
