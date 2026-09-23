---
name: three-webgl-game
description: Build and modify plain Three.js browser games with TypeScript, Vite, scene and camera control, GLB assets, physics, DOM HUD, and WebGL diagnostics.
---

# Three WebGL Game

Use this skill when the project wants direct control over a Three.js scene, camera, renderer, and game loop. Preserve another working 3D engine unless the user explicitly requests a migration.

## Runtime Boundaries

- Keep rules, AI, progression, quests, timers, and save state outside Three.js objects.
- Treat the scene graph as a rendering adapter over game state.
- Isolate renderer setup, resize, camera behavior, loading, object lifecycle, materials, physics, UI, and diagnostics.
- Make the camera mode explicit: orbit, follow, chase, rail, first-person, or authored cuts.
- Use GLB or glTF 2.0 for shipped 3D assets.
- Use a proven physics library such as Rapier when meaningful collision response is required.
- Keep HUD, menus, inventory, and settings in DOM by default.

## Feature And Bug Work

- Trace changes across simulation, render adapters, physics, camera, input, UI, and asset loading; edit only the layers the behavior actually crosses.
- Diagnose blank scenes through renderer size, camera framing, lighting, object transforms, loading failures, and WebGL errors before rewriting scene code.
- Diagnose movement or collision bugs at the simulation-to-physics boundary rather than compensating with mesh transforms.

## Browser Safety

- Handle resize and device pixel ratio deliberately.
- Dispose replaced geometry, materials, textures, controls, and event listeners.
- Keep post-processing optional and measurable.
- Plan for loading, errors, and WebGL context loss when the game depends on large or fragile GPU resources.
- Keep the first playable view visually open; reveal secondary panels on demand.

## Verification

Confirm the canvas renders nonblank pixels, the camera frames the intended play space, the affected interactions work, and resize does not break framing or UI. Use `../web-3d-asset-pipeline/SKILL.md` for asset shipping and `../game-playtest/SKILL.md` for browser QA.
