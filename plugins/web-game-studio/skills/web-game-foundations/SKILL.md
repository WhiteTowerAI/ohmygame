---
name: web-game-foundations
description: Set or repair browser-game architecture, including engine choice, game-state ownership, input, assets, save data, debugging, and performance boundaries.
---

# Web Game Foundations

Use this skill for architecture decisions or cross-cutting changes. For focused work in an established project, preserve its working boundaries and change only what the request requires.

## Choose The Runtime

- Preserve the existing runtime for features and bug fixes unless it blocks the requested outcome.
- Prefer Phaser for a new sprite, tilemap, arcade, tactics, or side-view 2D game.
- Prefer plain Three.js for a new imperative 3D runtime in TypeScript or Vite.
- Prefer React Three Fiber only when React state and composition are genuine requirements.
- Keep a working Canvas, Babylon.js, PlayCanvas, or custom runtime when the user or project has already chosen it.

## Stable Boundaries

- Simulation owns rules, entities, progression, timers, collisions, and saveable state.
- Rendering owns scene composition, animation playback, cameras, particles, and presentation state.
- Map keyboard, pointer, touch, and gamepad inputs to named game actions in one place.
- Keep text-heavy HUD and menus in DOM unless the visual design requires canvas or WebGL UI.
- Address assets through stable manifest keys rather than scattering file paths through gameplay code.
- Save serializable game state, not renderer objects.
- Keep debug and performance probes removable or easy to disable.

Use these boundaries in proportion to the project. A small game does not need an enterprise framework, but its rules should not become inseparable from rendering callbacks.

## Before Implementation

For a new or substantially changed game, establish:

- player fantasy and primary verbs
- core loop, success, failure, and restart behavior
- camera and input model
- simulation and rendering ownership
- asset organization and loading states
- HUD and menu surfaces
- save, debug, and performance expectations

Once the stack is clear, continue with the relevant runtime skill rather than expanding the architecture indefinitely.
