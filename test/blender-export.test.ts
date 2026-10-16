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
