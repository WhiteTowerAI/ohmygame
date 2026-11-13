---
name: phaser-2d-game
description: Build and modify Phaser 2D browser games with TypeScript, Vite, gameplay systems, scenes, cameras, animation, input, and DOM overlays.
---

# Phaser 2D Game

Use Phaser for new 2D games that benefit from sprites, tilemaps, cameras, timing, scene orchestration, or arcade-style interaction. Do not migrate a working non-Phaser game merely because this skill is available.

## Architecture

- Keep persistent rules and state independent of scene teardown; extract shared transitions when multiple entry points need them. Small scene-local behavior can stay in the scene.
- Use a small scene set: boot or preload, menu when needed, gameplay, and optional overlay or debug scenes.
- Treat sprites, tweens, emitters, and camera rigs as disposable view state.
- Use stable asset keys and centralize loading.
- Put dense HUD, menus, settings, and accessible controls in DOM overlays.

## Change Modes

- For a feature, trace the state owner, action mapping, scene adapter, HUD effects, and persistence impact before editing.
- For a bug, reproduce the relevant state transition and inspect timing, lifecycle, input, collision, and scene restart behavior before changing code.
- For a refactor, retain observable timing and controls unless the user requested behavior changes.

## Browser Requirements

- Resize the renderer and camera intentionally; do not stretch gameplay coordinates accidentally.
- Support keyboard and pointer input, and add touch controls when the target experience needs them.
- Pause or gate gameplay input under menus and dialogs.
- Keep effects readable: screen shake, hit stop, flashes, and particles should communicate state rather than hide it.

## Verification

Exercise changed actions; check transitions or restart when their state or lifecycle is affected. Use `../game-playtest/SKILL.md` to select build, browser or visual checks.
