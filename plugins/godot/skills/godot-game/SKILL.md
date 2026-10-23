---
name: godot-game
description: Create or edit Godot projects, scenes, GDScript, and imported assets, and diagnose Godot import or runtime errors.
---

# Godot Game

Read `project.godot` first. Keep the project's Godot version, renderer, input map, and scene layout; do not migrate the engine or rewrite settings as setup.

## Tools

The bundled Godot MCP takes the project's absolute path. Start with `get_godot_version` and `get_project_info`; a connected MCP does not prove Godot is installed. If the executable is not found, ask the user to set **Godot executable** in this plugin's configuration.

Use the MCP to create scenes and nodes and to run the game with `run_project`, `get_debug_output`, and `stop_project`; stop what you started. Edit GDScript and text resources with file tools. The MCP cannot capture the viewport or send gameplay input, so name the visual checks the user still needs.

Preserve `.uid` files and resource references (UID tools need Godot 4.4+). Never edit `.godot/`; Godot regenerates its import cache.

## Assets

Prefer GLB for 3D assets and keep editable sources outside imported folders or behind `.gdignore`. Put gameplay scripts and collision in a wrapper or inherited scene so reimporting the model keeps them. After import, check scale, orientation, pivots, materials, and animation names; glTF already converts axes.

## Verify from the CLI

```text
<godot> --headless --path <PROJECT> --editor --import
<godot> --headless --path <PROJECT> --quit-after <FRAMES>
```

Import first, then run the project or scene and fix every reported import or script error.
