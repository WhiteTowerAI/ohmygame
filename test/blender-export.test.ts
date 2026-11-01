import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const blender = process.env.BLENDER_EXECUTABLE;

describe("Blender GLB export", () => {
  it.skipIf(!blender)(
    "preserves packed textures, hierarchy, skin animation and morph targets in delivered GLBs",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-blender-assets-"),
      );
      try {
        const source = path.join(directory, "assets.blend");
        await run(
          blender!,
          [
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            path.resolve("test/fixtures/blender-assets.py"),
            "--",
            source,
          ],
          { timeout: 60_000 },
        );
        const original = await readFile(source);
        const exported = async (collection: string) => {
          const output = path.join(directory, `${collection}.glb`);
          await run(
            blender!,
            [
              "--background",
              source,
              "--python-exit-code",
              "1",
              "--python",
              path.resolve(
                "plugins/blender/skills/blender-assets/scripts/export_glb.py",
              ),
              "--",
              "--output",
              output,
              "--collection",
              collection,
            ],
            { timeout: 60_000 },
          );
          return new NodeIO().read(output);
        };

        const staticRoot = (await exported("StaticAsset")).getRoot();
        const prop = staticRoot
          .listNodes()
          .find((node) => node.getName() === "TexturedProp")!;
        expect(staticRoot.listMeshes()).toHaveLength(1);
        expect(prop.getParentNode()?.getName()).toBe("AssetRoot");
        // Blender Z-up is converted to glTF Y-up, retaining the parent's transforms.
        prop
          .getWorldTranslation()
          .forEach((value, axis) =>
            expect(value).toBeCloseTo([3, 1, 1.5][axis]!, 5),
          );
        const primitive = prop.getMesh()!.listPrimitives()[0]!;
        expect(primitive.getAttribute("TEXCOORD_0")?.getCount()).toBe(
          primitive.getAttribute("POSITION")!.getCount(),
        );
        const material = primitive.getMaterial()!;
        expect(material.getMetallicFactor()).toBeCloseTo(0.2);
        expect(material.getRoughnessFactor()).toBeCloseTo(0.35);
        expect(material.getAlphaMode()).toBe("BLEND");
        expect(material.getBaseColorFactor()[3]).toBeCloseTo(0.5);
        const texture = material.getBaseColorTexture()!;
        expect(texture.getMimeType()).toBe("image/png");
        expect(Array.from(texture.getImage()!.slice(0, 8))).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
        expect(staticRoot.listCameras()).toHaveLength(0);
        const excluded = new Set([
          "HiddenProp",
          "AnimatedProp",
          "PresentationCamera",
          "PresentationLight",
        ]);
        expect(
          staticRoot.listNodes().filter((node) => excluded.has(node.getName())),
        ).toEqual([]);

        const animatedRoot = (await exported("AnimatedAsset")).getRoot();
        const animated = animatedRoot
          .listNodes()
          .find((node) => node.getName() === "AnimatedProp")!;
        const skin = animated.getSkin()!;
        expect(skin.listJoints().map((joint) => joint.getName())).toEqual([
          "Base",
          "Tip",
        ]);
        expect(skin.getInverseBindMatrices()?.getCount()).toBe(2);
        const mesh = animated.getMesh()!.listPrimitives()[0]!;
        expect(mesh.getAttribute("JOINTS_0")?.getCount()).toBe(
          mesh.getAttribute("POSITION")!.getCount(),
        );
        const weights = mesh.getAttribute("WEIGHTS_0")!;
        for (let index = 0; index < weights.getCount(); index++) {
          expect(
            weights
              .getElement(index, [])
              .reduce((sum, weight) => sum + weight, 0),
          ).toBeCloseTo(1);
        }
        expect(mesh.listTargets()).toHaveLength(1);
        expect(
          mesh.listTargets()[0]!.getAttribute("POSITION")?.getCount(),
        ).toBe(mesh.getAttribute("POSITION")!.getCount());
        expect(
          mesh.listTargets()[0]!.getAttribute("POSITION")!.getMax([])[1],
        ).toBeCloseTo(0.25);
        const animations = animatedRoot.listAnimations();
        expect(animations.map((animation) => animation.getName())).toEqual(
          expect.arrayContaining(["Sway", "Stretch"]),
        );
        const sway = animations.find(
          (animation) => animation.getName() === "Sway",
        )!;
        const rotation = sway
          .listChannels()
          .find(
            (channel) =>
              channel.getTargetNode()?.getName() === "Tip" &&
              channel.getTargetPath() === "rotation",
          )!;
        const sampler = rotation.getSampler()!;
        expect(sampler.getInput()!.getMax([])[0]).toBeGreaterThan(0);
        const rotations = sampler.getOutput()!;
        expect(
          new Set(
            Array.from({ length: rotations.getCount() }, (_, index) =>
              JSON.stringify(rotations.getElement(index, [])),
            ),
          ).size,
        ).toBeGreaterThan(1);
        const stretch = animations.find(
          (animation) => animation.getName() === "Stretch",
        )!;
        const morph = stretch
          .listChannels()
          .find(
            (channel) =>
              channel.getTargetNode() === animated &&
              channel.getTargetPath() === "weights",
          )!;
        expect(morph.getSampler()!.getOutput()!.getMax([])[0]).toBeGreaterThan(
          0.9,
        );
        expect(await readFile(source)).toEqual(original);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!blender)(
    "exports a chosen collection, preserves the source, and refuses accidental overwrite",
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-blender-export-"),
      );
      try {
        const source = path.join(directory, "source.blend");
        const output = path.join(directory, "game asset.glb");
        const fixture = path.join(directory, "fixture.py");
        await writeFile(
          fixture,
          `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
collection = bpy.data.collections.new("GameAsset")
bpy.context.scene.collection.children.link(collection)
bpy.ops.mesh.primitive_cube_add()
asset = bpy.context.object
asset.name = "GameProp"
asset.data.name = "GamePropMesh"
bevel = asset.modifiers.new("EdgeBevel", "BEVEL")
bevel.width = 0.1
bevel.segments = 2
for parent in list(asset.users_collection):
    parent.objects.unlink(asset)
collection.objects.link(asset)
bpy.ops.mesh.primitive_cube_add(location=(10, 0, 0))
bpy.context.object.name = "PresentationOnly"
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(source)})
`,
        );
        await run(
          blender!,
          ["--background", "--python-exit-code", "1", "--python", fixture],
          { timeout: 60_000 },
        );
        const digest = async (file: string) =>
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex");
        const sourceBefore = await digest(source);
        const args = [
          "--background",
          source,
          "--python-exit-code",
          "1",
          "--python",
          path.resolve(
            "plugins/blender/skills/blender-assets/scripts/export_glb.py",
          ),
          "--",
          "--output",
          output,
          "--collection",
          "GameAsset",
        ];
        await run(blender!, args, { timeout: 60_000 });
        const document = await new NodeIO().read(output);
        expect(
          document
            .getRoot()
            .listMeshes()
            .map((mesh) => mesh.getName()),
        ).toEqual(["GamePropMesh"]);
        expect(
          document
            .getRoot()
            .listNodes()
            .map((node) => node.getName()),
        ).toContain("GameProp");
        expect(
          document
            .getRoot()
            .listNodes()
            .map((node) => node.getName()),
        ).not.toContain("PresentationOnly");
        expect(await digest(source)).toBe(sourceBefore);
        const outputBefore = await digest(output);
        await expect(
          run(blender!, args, { timeout: 60_000 }),
        ).rejects.toMatchObject({ code: 1 });
        expect(await digest(output)).toBe(outputBefore);
        await run(blender!, [...args, "--overwrite", "--apply-modifiers"], {
          timeout: 60_000,
        });
        const baked = await new NodeIO().read(output);
        expect(baked.getRoot().listMeshes()).toHaveLength(1);
        expect(
          baked
            .getRoot()
            .listMeshes()[0]!
            .listPrimitives()[0]!
            .getAttribute("POSITION")!
            .getCount(),
        ).toBeGreaterThan(
          document
            .getRoot()
            .listMeshes()[0]!
            .listPrimitives()[0]!
            .getAttribute("POSITION")!
            .getCount(),
        );
        const bakedBefore = await digest(output);
        const badScope = args.map((value) =>
          value === "GameAsset" ? "MissingCollection" : value,
        );
        await expect(
          run(blender!, [...badScope, "--overwrite"], { timeout: 60_000 }),
        ).rejects.toMatchObject({ code: 1 });
        expect(await digest(output)).toBe(bakedBefore);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
