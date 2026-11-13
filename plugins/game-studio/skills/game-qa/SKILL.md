---
name: game-qa
description: Verify games across engines with targeted boot, input, progression, regression, visual, and performance checks using available runtime tools and existing project tests.
---

# Game QA

Choose checks for affected risks, not a full pass by default. Reuse project checks and honor required checks. Add tests for meaningful behavior, regressions or boundaries, not wording or implementation trivia. After checks pass, repeat or broaden only for relevant changes, failures or new evidence.

## Choose The Pass

- `smoke`: launch, reach the first actionable state and exercise primary input; build when required by the runtime or task.
- `feature`: exercise the changed behavior, its entry/exit states, failure cases, and nearby systems.
- `bug regression`: reproduce the prior failure when possible, verify the fix, and check related paths.
- `visual`: inspect representative gameplay screenshots for framing, legibility, missing art, clipping, and HUD obstruction.
- `performance`: reproduce and measure the reported bottleneck with the engine's diagnostics before recommending optimization.

## Use The Available Runtime

For a configured OhMyGame Web preview, prefer `game_use`. Reuse its session, send real input, inspect runtime errors and failed asset loads, capture representative rendered states, and close the session in the same turn even after failure. OhMyGame owns the preview server; do not leave another development server running.

For native engines, inspect available `game_use` operations: `captureFrame` supports frames, not input or continuous play. Follow session ownership and cleanup rules. Use engine tools or existing automation for other checks; an editor connection alone is not a playtest. Do not add a Web wrapper or automation framework merely to verify a native game.

Use existing reset, seed, snapshot or step operations when needed. Add a minimal test-only bridge only if real input cannot reliably reach or identify the affected state; gameplay must not depend on it.

Protect user sessions and saves before resets or destructive setup. Check real input, relevant clocks, independent invariants and rejected actions; report setup that skips part of the journey. Test continuous transitions when earlier state affects later play.

## Player-Facing Checks

Select affected areas: loading, controls, feedback, progression, transitions, pause, restart or assets. Inspect changed art at game scale. Check supported devices when layout or input is affected, and built assets when packaging changes.

Report performed checks and gaps, separating compilation, simulation, interaction, screenshots, listening, device measurements and player feedback. If runtime tools are unavailable, use relevant existing checks. A build or one screenshot is not a full playtest; automated metrics do not prove enjoyment, sound quality, balance or retention.
