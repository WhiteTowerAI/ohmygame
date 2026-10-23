"""Export visible Blender objects as GLB without modifying the source file."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

import bpy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--collection")
    parser.add_argument("--apply-modifiers", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    options = parser.parse_args(arguments)
    output = Path(options.output).expanduser().resolve()
    if output.suffix.lower() != ".glb":
        raise ValueError("Output must have a .glb extension")
    if output.exists() and not options.overwrite:
        raise FileExistsError(f"Output exists; pass --overwrite to replace it: {output}")

    objects = list(bpy.context.scene.objects)
    if options.collection:
        collection = bpy.data.collections.get(options.collection)
        if collection is None:
            raise ValueError(f"Collection not found: {options.collection}")
        objects = list(collection.all_objects)
    objects = [obj for obj in objects if obj.visible_get() and not obj.hide_render]
    meshes = [obj for obj in objects if obj.type == "MESH"]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    geometry = [
        obj.evaluated_get(depsgraph) if options.apply_modifiers else obj
        for obj in meshes
    ]
    if not any(len(obj.data.polygons) for obj in geometry):
        raise ValueError("Export scope contains no visible mesh faces")

    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".blender-export-", dir=output.parent) as directory:
        temporary = Path(directory) / "asset.glb"
        result = bpy.ops.export_scene.gltf(
            filepath=str(temporary),
            export_format="GLB",
            use_selection=True,
            export_cameras=False,
            export_lights=False,
            export_apply=options.apply_modifiers,
        )
        if "FINISHED" not in result or not temporary.is_file():
            raise RuntimeError("Blender did not finish the GLB export")
        # A concurrent export must not replace a file without explicit overwrite.
        if options.overwrite:
            os.replace(temporary, output)
        else:
            os.link(temporary, output)

    print(json.dumps({
        "output": str(output),
        "bytes": output.stat().st_size,
        "meshes": [obj.name for obj in meshes],
        "collection": options.collection,
        "blender_version": bpy.app.version_string,
    }))


if __name__ == "__main__":
    main()
