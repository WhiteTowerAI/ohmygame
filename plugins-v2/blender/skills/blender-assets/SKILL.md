---
name: blender-assets
description: Create or refine game assets with a local Blender installation, keep the editable .blend source, and export GLB into the target project.
---

# Blender Assets

For a new asset, deliver an editable `.blend`, a runtime GLB, and a preview render. Follow the project's asset location, scale, axes, naming, and material conventions. For export-only tasks, leave the source untouched.

## Run Blender

Find the executable on PATH or in its usual location (macOS `/Applications/Blender.app/Contents/MacOS/Blender`, Windows `Program Files/Blender Foundation`) and check `--version`. `bpy` exists only in Blender's bundled Python, so run scripts through Blender; put an existing `.blend` before `--python`:

```text
<blender> --background [<SOURCE.blend>] --python-exit-code 1 --python <SCRIPT.py>
```

Save new sources explicitly with `bpy.ops.wm.save_as_mainfile`. Name datablocks explicitly and select shader nodes by type, because default node labels follow Blender's UI language. Bake procedural shading that glTF cannot represent.

## Export

Use the bundled helper (path relative to this Skill):

```text
<blender> --background <SOURCE.blend> --python-exit-code 1 --python <SKILL_DIR>/scripts/export_glb.py -- --output <ASSET.glb> [--collection <NAME>] [--apply-modifiers] [--overwrite]
```

It exports the scene's visible objects, or a named collection with its child collections, without cameras or lights. It refuses to replace an existing file without `--overwrite`, never saves the `.blend`, and prints a JSON summary. Keep every required mesh, armature, and parent in scope and presentation-only objects out of it. `--apply-modifiers` bakes modifiers but drops shape keys; leave it off for morph targets. glTF converts axes; do not add an extra rotation.

## Verify

Render a preview and read the image. Load the GLB in the target engine and check scale, orientation, pivot, materials, textures, and animation. Without a target engine, reimport it into a clean Blender scene and report the runtime check as pending.
