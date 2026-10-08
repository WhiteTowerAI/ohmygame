---
name: web-game-studio
description: Create complete browser games from short ideas, coordinating canvas design, visual mockups, art, implementation, and playtesting; route changes that span specialist domains.
---

# Web Game Studio

Use this skill for new browser games and work that spans multiple domains or has no clear implementation path. Preserve an existing project's stack and conventions unless the user explicitly asks for a migration.

## Classify The Work

Choose the task mode before choosing technology:

- `create`: deliver a coherent game with a complete core loop, intentional art, clear controls, failure or reset behavior, and player feedback.
- `feature`: trace the existing architecture, define the integration points, implement the requested behavior, and check nearby regressions.
- `bugfix`: reproduce or establish evidence, identify the cause, make the smallest reliable fix, and rerun the affected flow.
- `polish`: tie visual, audio, input, or performance changes to a named player-facing improvement.
- `refactor`: preserve observable gameplay while improving internal boundaries.

Do not turn a focused feature or bug request into a redesign of the whole game.

## Create A Game

Apply the requested scope: discussion, design-only, graybox, and no-generation requests override the full creation workflow.

1. Read the workspace; use `canvas_initialize` if the canvas is missing, then read its instructions and schemas. Resolve the player fantasy, core loop, controls, progression, success/failure/reset behavior, first playable scope, and visual direction. Record these decisions and the required assets in the canvas main design document; register it in `index.json` and place a document node on the board. Build on an existing design when present.
2. Use `game-ui-frontend` for visual direction and key-screen mockups. Create canvas generation nodes for those mockups and the art the game needs, with clear purposes, dimensions, and references. Generate through `generate_canvas_media`, inspect the outputs, and use suitable outputs as references to keep production art consistent. Reuse existing assets where they fit; a mockup guides the playable interface rather than serving as the interface itself.
3. Implement the full playable loop with the appropriate runtime skill and integrate the final assets. Keep the design document consistent with meaningful implementation decisions.
4. Use `game-playtest` to exercise primary actions, progression, failure/reset, and representative viewports. Compare actual screenshots with the visual direction, repair shortcomings, and recheck affected states before delivery.

When generation or visual inspection is unavailable, continue the runnable work with a coherent fallback and report what remains unverified or unfinished. Do not retry an unchanged failing generation indefinitely.

## Route By Domain

Read only the specialist skills needed for the request:

- Architecture, engine choice, state, input, save, or performance boundaries: `../web-game-foundations/SKILL.md`
- Phaser 2D runtime work: `../phaser-2d-game/SKILL.md`
- Plain Three.js runtime work: `../three-webgl-game/SKILL.md`
- React-hosted Three.js work: `../react-three-fiber-game/SKILL.md`
- Visual direction, screen mockups, HUD, menus, responsive layout, or touch controls: `../game-ui-frontend/SKILL.md`
- 2D sprite generation and normalization: `../sprite-pipeline/SKILL.md`
- GLB or glTF preparation and optimization: `../web-3d-asset-pipeline/SKILL.md`
- Browser smoke tests, gameplay regression checks, or visual QA: `../game-playtest/SKILL.md`

When the request already has one clear domain, use that specialist directly. For mixed work, keep one plan and one definition of done across all specialists.

## Runtime Defaults

- Keep the current engine when modifying an existing game.
- For a new 2D game, prefer Phaser with TypeScript and Vite unless the request calls for another stack or a smaller existing approach fits better.
- For a new plain TypeScript 3D game, prefer Three.js.
- Use React Three Fiber when the project already uses React or the user explicitly wants a React-hosted 3D scene.
- Use raw Canvas or WebGL when the user asks for it or the game's small scope makes an engine unnecessary.

## OhMyGame Contract

- Follow the workspace's `AGENTS.md`. In an existing project, preserve its build tool and output layout unless the user requests a migration.
- Keep preview commands runnable. When publishing is in scope, produce static output supported by OhMyGame.
- Make the game responsive inside an iframe without horizontal overflow.
- Use OhMyGame media tools when they fit the task; generated assets still need integration and in-game verification.
- Do not leave a development server running after the turn.
- Verify in proportion to the change. Never claim visual or gameplay checks that were not actually performed.
