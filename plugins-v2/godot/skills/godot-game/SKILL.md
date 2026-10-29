---
name: godot-game
description: Create or edit Godot projects, scenes, GDScript, and imported assets, and diagnose Godot import or runtime errors.
---

# Godot Game

Read `project.godot` first. Keep the project's Godot version, renderer, input map, and scene layout; do not migrate the engine or rewrite settings as setup.

## Tools

Start with `godot_status`: it says which Godot executable the project uses, its version, and whether the web export templates are installed. If Godot is missing, ask the user to install Godot 4.3 or later, or to set its executable in the Godot plugin's settings; if the web templates are missing, ask them to install them in Godot (Editor > Manage Export Templates).

After editing scripts or scenes, call `run_headless` and fix every error it reports. Pass `scene` to run one scene, and `frames` for longer checks.

The game panel plays a web build. `export_web` rebuilds it into `.ohmygame/build/web`; the panel also rebuilds when it starts. Keep the project on the Compatibility renderer and avoid features the web export lacks (threads, GDExtension, some audio and file APIs). The person can still use **Run in Godot** for the full engine.

Edit GDScript, scenes and text resources with file tools. Preserve `.uid` files and resource references (UID tools need Godot 4.4+). Never edit `.godot/`; Godot regenerates its import cache. Keep the `Web` preset in `export_presets.cfg`.

## Assets

Prefer GLB for 3D assets and keep editable sources outside imported folders or behind `.gdignore`. Put gameplay scripts and collision in a wrapper or inherited scene so reimporting the model keeps them. After import, check scale, orientation, pivots, materials, and animation names; glTF already converts axes.
