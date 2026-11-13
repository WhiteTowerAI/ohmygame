---
name: game-foundations
description: Set or repair engine-independent game architecture, including runtime choice, simulation and presentation ownership, input, assets, save data, debugging, and performance boundaries.
---

# Game Foundations

Use for architecture decisions and changes crossing several game systems. Preserve the existing engine and working boundaries unless the requested outcome requires a change.

## Choose The Runtime

Start with the target platform, distribution, camera, primary actions, asset needs, and existing project. Respect an explicitly chosen engine. For an unspecified new game, choose a runtime that fits those requirements and available tooling; do not select a browser stack solely because the workspace offers Web previews. Keep the choice proportionate to the game.

## Stable Boundaries

- Keep rules, entity identity, timers, progression and saves independent of UI wording, cameras and view lifetimes. Share transitions across input paths; define relevant pause, resume, restart and reconnect behavior. Presentation adapts this state into the game's scenes, audio and UI.
- Map supported input devices to named game actions in one place. Gate gameplay input while menus and dialogs are active.
- Use stable asset keys and a deliberate loading/import pipeline instead of scattering file paths through gameplay logic.
- Preserve existing saves. Store versioned, serializable state; migrate on load and refuse destructive writes when data cannot be read. Verify recovery with the actual identity and storage location. Isolate test progress from the user's session.
- Keep diagnostics easy to disable, and clean up replaced resources, listeners, and subscriptions through the engine's lifecycle.

Use the engine's existing boundaries; add layers only when ownership or lifecycle requires them. Validate external input, saves, permissions and shared writes; trust established internal types and contracts. Add guards, retries, fallbacks or compatibility only for concrete failure modes, with explicit recovery; never hide errors with defaults.

## Progression And Economy

When changing progression or an economy, check reachability before estimating completion time. Trace sources, sinks, capacities, unlocks, permanent bonuses and positive feedback together. Compare early, middle and late milestones under representative player choices, stating assumptions about claiming rewards, spending and randomness. Keep comparable baselines; inspect ranges and failure cases, not just averages. A tuning slider exposes parameters; it does not establish balance.

## Before Implementation

For a new or substantially changed game, establish the core loop, success/failure/restart, camera and controls, state ownership, asset loading, UI surfaces, saving, and performance expectations. Keep gameplay legible: persistent HUD should support current decisions, protect the main action area, and put secondary information in contextual or pause surfaces.

Preserve approved visual direction, sprite anchors, model units, and asset naming in focused changes. Size and optimize resources for their actual use. Measure a reported bottleneck before introducing pooling, compression, LODs, or architectural changes.

Once the required boundaries are clear, continue implementation with the chosen engine's conventions and any relevant available specialist workflow.
