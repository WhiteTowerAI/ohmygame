---
name: react-three-fiber-game
description: Build and modify React-hosted 3D browser games with React Three Fiber, shared app state, physics, asset loading, and coordinated DOM UI.
---

# React Three Fiber Game

Use this skill when an existing React application hosts the game or when React-based composition and shared UI state are explicit requirements. Do not choose React Three Fiber only because React is familiar.

## Core Boundaries

- Keep gameplay simulation outside render components.
- Use React state for app and UI coordination, not for high-frequency per-frame mutation across the whole tree.
- Isolate the `Canvas`, camera rigs, controls, loaders, physics bridge, and post-processing.
- Use refs or focused stores for imperative frame work while keeping state ownership clear.
- Keep HUD, menus, settings, and accessibility-sensitive controls in the normal DOM tree.
- Gate camera and gameplay input while pointer-driven overlays are active.

Use pmndrs libraries when they simplify a real requirement: Drei for common scene helpers, React Three Rapier for physics, and React Three Postprocessing for measured visual effects. Avoid adding packages preemptively.

## Existing Project Work

- Follow current state-management and component conventions.
- For features, identify whether state belongs to simulation, shared app state, scene composition, or transient render state.
- For bugs, check stale closures, effect cleanup, duplicate subscriptions, suspense or loading boundaries, and per-frame state churn before restructuring components.
- Preserve player-visible behavior during refactors.

## Verification

Check React and scene state remain synchronized, overlays do not steal or leak input, the canvas renders after resize, and unmounting cleans up listeners and resources. Use `../game-playtest/SKILL.md` for end-to-end browser checks.
