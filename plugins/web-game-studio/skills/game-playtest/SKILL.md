---
name: game-playtest
description: Test browser games through boot, input, gameplay states, regression paths, responsive layouts, screenshots, and structured player-facing QA.
---

# Game Playtest

Test the game as a player experiences it. Match the depth of verification to the change and distinguish build success from actual browser or gameplay validation.

## Choose The Pass

- `smoke`: build, boot, reach the first actionable state, and confirm primary input.
- `feature`: exercise the new behavior, its entry and exit states, failure cases, and nearby systems.
- `bug regression`: reproduce the old failure when possible, verify the fix, and check the nearest related paths.
- `visual`: capture representative states and inspect playfield visibility, hierarchy, clipping, and feedback.
- `performance`: measure the reported bottleneck with browser or renderer diagnostics before recommending optimization.

## Workflow

1. Read the project's existing scripts and test setup.
2. Build or run the narrowest relevant automated checks.
3. Start a temporary server only when browser verification needs it, and stop it when finished.
4. Use available browser automation for input and screenshots. For canvas or WebGL games, DOM assertions alone are insufficient.
5. Exercise primary actions, pause or modal states, restart or failure paths, and the changed behavior.
6. Check representative desktop and mobile viewport sizes when layout is affected.
7. Record what was actually tested and any remaining unverified behavior.

If browser automation or visual inspection is unavailable, run the strongest available build and logic checks and say plainly that the game was not visually playtested.

## Review Focus

- first actionable screen and control discoverability
- input feedback, timing, and state transitions
- HUD obstruction, clipping, and responsive behavior
- scene or route transitions and restart behavior
- loading, missing assets, console errors, and blank canvas states
- camera, pointer lock, modal focus, and touch controls where relevant
- sprite anchors for 2D and framing, lighting, collision, and loading for 3D

When reporting issues, lead with severity, reproduction, player impact, and the likely owning subsystem. When asked to fix issues, make focused changes and rerun the affected checks.
