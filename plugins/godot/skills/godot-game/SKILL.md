---
name: godot-game
description: Create or edit Godot projects, scenes, GDScript, and imported assets, and diagnose Godot import or runtime errors.
---

# Godot Game

Read `project.godot` first. Keep the project's Godot version, renderer, input map, and scene layout; do not migrate the engine or rewrite settings as setup.

## Tools

Start with `godot_status`: it says which Godot executable the project uses, its version, and whether the web export templates are installed. If Godot is missing, ask the user to install Godot 4.3 or later, or to set its executable in the Godot plugin's settings.

After editing scripts or scenes, call `run_headless` and fix every error it reports. Pass `scene` to run one scene, and `frames` for longer checks.

The Godot MCP server uses the same Godot and takes the project's absolute path. Use it to create scenes and nodes, load sprites, and run the game with `run_project`, `get_debug_output`, and `stop_project`; stop what you started. It cannot capture the viewport or send gameplay input, so name the visual checks the user still needs.

Edit GDScript, scenes and text resources with file tools. Preserve `.uid` files and resource references (UID tools need Godot 4.4+). Never edit `.godot/`; Godot regenerates its import cache.

## Godot game projects

In a Godot game project, the game panel plays a web build. `export_web` rebuilds it into `.ohmygame/build/web`; the panel also rebuilds when it starts. Keep the project on the Compatibility renderer and avoid features the web export lacks (threads, GDExtension, some audio and file APIs), and keep the `Web` preset in `export_presets.cfg`. If `godot_status` says the web templates are missing, ask the user to install them in Godot (Editor > Manage Export Templates). The person can still use **Run in Godot** for the full engine.

In other projects, the Godot project may target any platform: keep its renderer and export presets, and don't add a web export unless asked.

## Assets

Prefer GLB for 3D assets and keep editable sources outside imported folders or behind `.gdignore`. Put gameplay scripts and collision in a wrapper or inherited scene so reimporting the model keeps them. After import, check scale, orientation, pivots, materials, and animation names; glTF already converts axes.
