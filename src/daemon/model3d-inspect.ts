import { NodeIO, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import type { Model3DMetadata } from "../shared/contracts.js";
import { Model3DGenerationError } from "./model3d.js";

export async function inspectModel3D(bytes: Buffer): Promise<Model3DMetadata> {
  try {
    const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
    const root = document.getRoot();
    let triangles = 0;
    for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      const mode = primitive.getMode();
      if (mode === 4) triangles += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
    }
    if (!triangles) throw new Error("Model has no triangle geometry");
    return { triangles, textured: root.listTextures().length > 0, rigged: root.listSkins().length > 0, animations: root.listAnimations().map((clip) => clip.getName()) };
  } catch (cause) { throw new Model3DGenerationError(`Invalid GLB model: ${cause instanceof Error ? cause.message : String(cause)}`, 400); }
}
/** Preserve skins and animation transforms by rotating a new scene parent, leaving local bone coordinates intact. */
export async function modelFacingPositiveZ(bytes: Buffer, axis?: Model3DMetadata["forwardAxis"]): Promise<Buffer> {
  if (axis !== "+X") return bytes;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), document = await io.readBinary(bytes);
  // A root may belong to several scenes. Snapshot memberships before addChild
  // removes those memberships, and share its wrapper across the same scenes.
  const scenes = document.getRoot().listScenes().map((scene) => ({ scene, children: scene.listChildren() }));
  const parents = new Map<Node, Node>();
  for (const { scene, children } of scenes) {
    for (const child of children) {
      let parent = parents.get(child);
      if (!parent) {
        parent = document.createNode("Forward axis +Z").setRotation([0, -Math.SQRT1_2, 0, Math.SQRT1_2]).addChild(child);
        parents.set(child, parent);
      }
      scene.addChild(parent);
    }
  }
  return Buffer.from(await io.writeBinary(document));
}
