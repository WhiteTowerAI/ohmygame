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
2. Build or run the narrowest relevant automated checks. Treat this as build or logic evidence, not proof that the game works in a browser.
3. Prefer the built-in `playtest_browser` tool when it is available. Open the current project preview, reuse its `sessionId`, and close the session in the same turn even when a check fails.
4. Inspect the initial runtime state for loading failures, console errors, failed requests, interactive elements, canvas visibility, and optional game-bridge state.
5. Exercise primary actions, pause or modal states, restart or failure paths, and the changed behavior with real browser input.
6. Capture every representative Canvas or WebGL state. DOM inspection cannot establish that a rendered frame is nonblank, correctly framed, or unobstructed.
7. Check representative desktop and mobile viewport sizes when layout is affected. Reinspect and recapture after resizing.
8. Record build, runtime, interaction, visual, and responsive results separately, including anything that remains unverified.

## Browser Tool Policy

- `playtest_browser` is the preferred OhMyGame path. Use `open`, `inspect`, `act`, `capture`, and `close`; it starts or reuses the current project preview and does not accept arbitrary external sites.
- Prefer semantic targets such as role, name, test ID, or text for DOM controls. Use coordinates for the canvas playfield when the game has no semantic target.
- When `bridgeCapabilities` are present, use `snapshot` state for assertions and `reset`, `setSeed`, or `step` to reach deterministic states. Still send real input and inspect screenshots; the bridge is not a substitute for player-facing verification.
- Do not add a game bridge for routine playtesting. Add the smallest test-only bridge only when real input cannot reliably reach or identify an important state, and do not restructure the game solely to support the bridge.
- Fall back to browser automation already owned by the project when the built-in tool is unavailable.
- Do not install Playwright, Puppeteer, browser binaries, or other automation packages only to complete a playtest. Add test infrastructure only when the user asks for it or it is part of the requested implementation.
- If neither visual browser path is available, run the strongest build and logic checks available and state plainly that the game was not visually playtested.

Treat screenshot blank-frame analysis as a warning signal, not a complete visual assertion. A uniformly colored loading screen can look blank to the heuristic, while a broken but noisy frame can pass it.

## Review Focus

- first actionable screen and control discoverability
- input feedback, timing, and state transitions
- HUD obstruction, clipping, and responsive behavior
- scene or route transitions and restart behavior
- loading, missing assets, console errors, and blank canvas states
- camera, pointer lock, modal focus, and touch controls where relevant
- sprite anchors for 2D and framing, lighting, collision, and loading for 3D

When reporting issues, lead with severity, reproduction, player impact, and the likely owning subsystem. When asked to fix issues, make focused changes and rerun the affected checks. Do not claim a full playtest from a successful build, a DOM-only inspection, or one screenshot.
