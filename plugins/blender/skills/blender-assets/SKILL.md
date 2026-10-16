---
name: blender-assets
description: Create, refine, or prepare game assets with a local Blender installation, preserve editable blend sources, and export GLB into the target project.
---

# Blender Assets

Deliver an editable `.blend`, a runtime GLB, and a useful preview image when creating a new asset. Follow the target project's asset locations, scale, axes, names, and material conventions. For export-only tasks, preserve the supplied source.

## Local execution

Find Blender through PATH or the user's installation. Common macOS executable: `/Applications/Blender.app/Contents/MacOS/Blender`; Windows installations commonly live under `Program Files/Blender Foundation`. Verify the actual executable with `--version`. If unavailable, explain the missing dependency and retain any authored scripts for later execution.

Use Blender's bundled Python through `<blender> --background --python-exit-code 1 --python <SCRIPT>`. When working on an existing file, place its absolute `.blend` path before `--python`. Resolve paths in `bpy` explicitly; a standalone system Python cannot import Blender's `bpy` by default.

Write task-specific modeling scripts in the workspace when useful. Save new source files explicitly with `bpy.ops.wm.save_as_mainfile`, preserving existing work. Choose geometry, bevels, materials, and texture size for the asset's visible role rather than imposing a fixed polygon budget.

Assign explicit datablock names and select shader nodes by type; translated default labels vary with Blender's UI language.

## Export

Prepare transforms and origin deliberately; keep armatures and animation intact. Bake procedural materials only when the runtime requires it. glTF handles the Blender-to-runtime axis conversion.

For repeatable export, run the bundled helper (resolve this path relative to this Skill):

```text
<blender> --background <SOURCE.blend> --python-exit-code 1 --python <SKILL_DIR>/scripts/export_glb.py -- --output <ASSET.glb> [--collection <NAME>] [--apply-modifiers] [--overwrite]
```

The helper exports visible scene objects, or a named collection and its children, without cameras/lights. Keep all required mesh, armature, and parent objects in that scope. It refuses empty mesh exports and existing output files unless `--overwrite` is supplied. It prints a JSON summary and does not save changes to the source `.blend`.

Use `--apply-modifiers` to bake modifiers such as bevels into static asset geometry. This exporter option disables shape-key export; leave it off for morph targets and verify the exported animation/geometry explicitly.

## Verify the delivery

Render a preview using an appropriate camera, lighting, and background; keep presentation-only objects out of the export collection. Open the resulting image to assess the asset.

Load the GLB through the project's actual loader or engine. Check scale, orientation, pivot, materials, texture availability, animation names, and errors. Godot projects should run their import check; web projects should load the asset in their established scene workflow. A Blender render or successful file write alone does not prove runtime appearance.

Report artifact paths and the checks actually performed. Add collision proxies, LOD, rigging, or compression when requested or required by the target runtime.
