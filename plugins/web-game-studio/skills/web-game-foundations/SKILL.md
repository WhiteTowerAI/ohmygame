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

- Route equivalent player actions through shared domain transitions. Keep entity identity, quantities, timers and progression independent of UI wording, camera changes and view lifetimes. Define pause, resume, restart and reconnect behavior.
- Simulation owns rules, entities, progression, timers, collisions, and saveable state.
- Rendering owns scene composition, animation playback, cameras, particles, and presentation state.
- Map keyboard, pointer, touch, and gamepad inputs to named game actions in one place.
- Keep text-heavy HUD and menus in DOM unless the visual design requires canvas or WebGL UI.
- Address assets through stable manifest keys rather than scattering file paths through gameplay code.
- Preserve existing saves. Store versioned, serializable state; migrate on load and refuse destructive writes when data cannot be read. Verify recovery with the actual identity and storage location. Isolate test progress from the user's session.
- Keep debug and performance probes removable or easy to disable.

Use these boundaries in proportion to the project. A small game does not need an enterprise framework, but its rules should not become inseparable from rendering callbacks.

## Multiplayer

Use OhMyGame's Colyseus integration unless the user explicitly requests another stack. Read `multiplayer_setup`'s current schema and generated SDK guide rather than assuming a fixed adapter list. The service keeps rooms; the mode determines who executes rules. Built-in rules run on the service; custom rules run on a browser host or in deterministic lockstep; owner rooms let each page run its own player. Do not claim server-authoritative results for browser-owned rules. Follow the guide's leaderboard restrictions and owner-only scope of SDK p2p.

Keep connection, room membership, game phase and local presentation distinct. Handle invalid commands, join failures, disconnect, refresh, reconnect and host changes where applicable. Test independent player identities and the requested room size, checking what each player can see and do. Keep the SDK's default localStorage identity: two tabs share a player; use a private window or another browser, not per-tab storage, for another player.

Local rooms do not survive the daemon stopping. Verify recovery with the same identity and actual saved state. Public deployment is separate from local setup and must match the rules and build. Report missing services or unsupported requirements explicitly rather than silently substituting a backend. An explicitly requested alternative may have separate hosting requirements.

## Progression And Economy

When changing progression or an economy, check reachability before estimating completion time. Trace sources, sinks, capacities, unlocks, permanent bonuses and positive feedback together. Compare early, middle and late milestones under representative player choices, stating assumptions about claiming rewards, spending and randomness. Keep comparable baselines; inspect ranges and failure cases, not just averages. A tuning slider exposes parameters; it does not establish balance.

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
