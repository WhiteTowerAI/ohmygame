---
name: godot-game
description: Create or edit Godot projects, scenes, GDScript, and imported assets; diagnose Godot import and runtime errors.
---

# Godot Game

Use the project's existing Godot version, scene organization, input map, and renderer. Inspect `project.godot` before choosing APIs; avoid migrating the engine or rewriting project settings as setup.

## Tools and readiness

The bundled Godot MCP can inspect project files, create scenes and nodes, launch the editor or game, and collect debug output. Edit GDScript and text resources with the agent's file tools. Discover the connected server's tool schemas before calling it; pass the current project's absolute path.

Call `get_godot_version` to check the engine, then inspect the current project with `get_project_info`. A successful MCP connection alone does not prove Godot is installed. If discovery fails, configure **Godot executable** in this plugin and test again. Keep the established server identity and user configuration.

Existing service-definition overrides take precedence over the bundled definition. If the configured executable is ignored, inspect that override and use plugin configuration assistance to bind its `GODOT_PATH` to `${config.godot-path}`, preserving the other custom fields.

UID tools require Godot 4.4+. Preserve `.uid` files and existing resource references; let Godot generate import caches rather than editing `.godot/`.

## Assets and scenes

- Prefer GLB for Blender runtime assets and retain editable `.blend` source in the project's established source-art location. A source directory inside Godot's resource tree may use `.gdignore` when it should not be imported.
- Confirm scale, orientation, pivots, materials, and animation names in Godot after import. Let the glTF exporter perform axis conversion; avoid adding an unverified extra rotation.
- Keep imported scenes reusable. Put gameplay behavior and collision in the project's wrapper or inherited scenes so reimporting the model preserves that work.
- Add collision, LOD, animation setup, and compression only for the asset's actual runtime needs.

## Verification

Use the detected/configured executable for CLI checks. Import first with `<godot> --headless --path <PROJECT> --editor --import`, then run the intended scene or project. Read the complete import/runtime errors and fix the affected resource or script.

For a bounded smoke run, use `<godot> --headless --path <PROJECT> --quit-after <FRAMES>` with a frame budget appropriate to the test. MCP `run_project`, `get_debug_output`, and `stop_project` provide the interactive process loop; stop the process started for the test when finished.

Distinguish successful import, process startup, gameplay assertions, and visual inspection. The bundled MCP does not provide live viewport screenshots or gameplay input, and OhMyGame's web `game_use` workflow does not cover Godot. Report the evidence obtained and any remaining visual/manual checks.
