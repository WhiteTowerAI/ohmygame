---
name: react-three-fiber-game
description: Build and modify React-hosted 3D browser games with React Three Fiber, shared app state, physics, asset loading, and coordinated DOM UI.
---

# React Three Fiber Game

Use this skill when an existing React application hosts the game or when React-based composition and shared UI state are explicit requirements. Do not choose React Three Fiber only because React is familiar.

## Core Boundaries

- Keep gameplay simulation outside render components.
- Use React state for app and UI coordination, not for high-frequency per-frame mutation across the whole tree.
- Separate `Canvas`, controls and other systems where ownership or lifecycle requires it.
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

Check affected state synchronization, overlay input or lifecycle; test resize and unmount when changed. Use `../game-playtest/SKILL.md` to select browser checks.
