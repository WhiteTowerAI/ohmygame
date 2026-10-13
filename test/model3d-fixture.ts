import { Document, NodeIO } from "@gltf-transform/core";

/** A real triangle GLB, optionally textured/skinned/animated, for geometry and recovery tests. */
export async function model3DFixture(options: { textured?: boolean; rigged?: boolean; clips?: string[] } = {}): Promise<Buffer> {
  const document = new Document(), buffer = document.createBuffer();
  const position = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  if (options.textured !== false) {
    const texture = document.createTexture().setMimeType("image/png").setImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cB84AAAAASUVORK5CYII=", "base64"));
    primitive.setMaterial(document.createMaterial().setBaseColorTexture(texture));
    primitive.setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer));
  }
  const mesh = document.createMesh().addPrimitive(primitive), node = document.createNode("Character").setMesh(mesh);
  const joint = document.createNode("Root");
  document.createScene().addChild(node).addChild(joint);
  if (options.rigged) {
    node.setSkin(document.createSkin().addJoint(joint));
    primitive.setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint16Array(12)).setBuffer(buffer));
    primitive.setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0])).setBuffer(buffer));
  }
  for (const name of options.clips ?? []) {
    const times = document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const values = document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0])).setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(times).setOutput(values);
    document.createAnimation(name).addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath("translation").setSampler(sampler));
  }
  return Buffer.from(await new NodeIO().writeBinary(document));
}
export const TEST_GLB = await model3DFixture();
