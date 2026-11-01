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

Apply the requested scope: discussion, design-only, graybox, no-generation, and explicitly requested procedural art override the corresponding creation defaults.

1. Read the workspace; use `canvas_initialize` if the canvas is missing, then read its instructions and schemas. Resolve the player fantasy, core loop, controls, progression, success/failure/reset behavior, first playable scope, and visual direction. Record these decisions and an asset list with gameplay roles, specifications, sources, and runtime destinations in the canvas main design document; register it in `index.json` and place a document node on the board. Build on an existing design when present.
2. Use `game-ui-frontend` for visual direction and key-screen mockups. Save mockup generation nodes with clear purposes, dimensions, and references. Generate through `generate_canvas_media`, inspect the outputs, and use suitable outputs as visual references for production art. Mockups establish direction; they do not fulfill the gameplay asset list.
3. Reuse suitable assets and generate missing production art for the characters, enemies, items, card illustrations, environments, and themed HUD elements the game needs. Use `sprite-pipeline` or `web-3d-asset-pipeline` when appropriate. Save production generation nodes with dimensions and shared references, run `generate_canvas_media`, inspect and prepare the outputs, and integrate them into the full playable loop with the appropriate runtime skill. Use code drawing for simple geometry, particles, and dynamic UI; pixel art does not imply drawing detailed sprites in code. Share assets, atlases, and variants where appropriate; cover gameplay needs without a fixed image quota. Keep the design document consistent with meaningful implementation decisions.
4. Use `game-playtest` to exercise primary actions, progression, failure/reset, and representative viewports. Check the asset list against actual files and runtime usage, then inspect gameplay screenshots for visual consistency, legibility, missing art, and HUD obstruction. Repair shortcomings and recheck affected states before delivery; mockups, empty generation nodes, and unused files do not establish visual completion.

When a required asset cannot be generated because the tool is unavailable or fails, use a coherent substitute and disclose that gap. Implementation convenience alone is not a reason to replace required production art with code-drawn placeholders. When visual inspection is unavailable, report what remains unverified. Do not retry an unchanged failing generation indefinitely.

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
