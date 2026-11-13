---
name: game-playtest
description: Test browser games through boot, input, gameplay states, regression paths, responsive layouts, screenshots, and structured player-facing QA.
---

# Game Playtest

Choose checks for affected risks, not a full pass by default. Reuse project checks and honor required checks. Add tests for meaningful behavior, regressions or boundaries, not wording or implementation trivia. After checks pass, repeat or broaden only for relevant changes, failures or new evidence.

## Choose The Pass

- `smoke`: boot, reach the first actionable state and confirm primary input; build when the task requires it.
- `feature`: exercise the new behavior, its entry and exit states, failure cases, and nearby systems.
- `bug regression`: reproduce the old failure when possible, verify the fix, and check the nearest related paths.
- `visual`: capture representative states and inspect playfield visibility, hierarchy, clipping, and feedback.
- `performance`: measure the reported bottleneck with browser or renderer diagnostics before recommending optimization.

## Workflow

1. Read existing scripts and tests; select the relevant checks for the changed behavior. Build when compilation or packaging is at issue.
2. For runtime checks, open `game_use`, reuse its session and close it in the same turn even after failure. Inspect loading errors, failed requests and the affected state.
3. Exercise changed actions and related transitions with real input. Capture affected rendered states; DOM inspection alone cannot verify Canvas or WebGL output.
4. Check representative supported viewports when layout or input changes. Inspect built assets when packaging changes.

## Game Use Policy

- `game_use` is the OhMyGame path for game interaction and verification. Use `open`, `inspect`, `act`, `capture`, and `close`; when the person asks for a video of the game, wrap the `act` calls in `recordStart` and `recordStop` (60 seconds at most), which saves it to their Library; it starts or reuses the current project preview and does not accept arbitrary external sites.
- Prefer semantic targets such as role, name, test ID, or text for DOM controls. Use coordinates for the canvas playfield when the game has no semantic target.
- Use available `snapshot`, `reset`, `setSeed` or `step` only as needed to reach or assert a state; still verify the relevant input and rendered result. Add a minimal test-only bridge only when real input cannot reliably reach or identify the affected state; gameplay must not depend on it.
- Fall back to automation already owned by the project when the built-in runtime adapter is unavailable.
- Do not install Playwright, Puppeteer, browser binaries, or other automation packages only to complete a playtest. Add test infrastructure only when the user asks for it or it is part of the requested implementation.
- If no visual runtime is available, use relevant existing checks and report the visual gap.

Treat screenshot blank-frame analysis as a warning signal, not a complete visual assertion. A uniformly colored loading screen can look blank to the heuristic, while a broken but noisy frame can pass it.

Protect user sessions and saves before resets or destructive setup. Check relevant clocks, independent invariants and rejected actions; report setup that skips part of the journey. Test continuous transitions when earlier state affects later play.

## Review Focus

Select only areas affected by the change:

- first actionable screen and control discoverability
- input feedback, timing, and state transitions
- HUD obstruction, clipping, and responsive behavior
- scene or route transitions and restart behavior
- loading, missing assets, console errors, and blank canvas states
- camera, pointer lock, modal focus, and touch controls where relevant
- sprite anchors for 2D and framing, lighting, collision, and loading for 3D

Report issues by severity, reproduction, player impact and owner. Distinguish compilation, simulation, interaction, screenshots, listening, device checks and player feedback. A build or one screenshot is not a full playtest; automated metrics do not prove enjoyment, sound quality, balance or retention.
