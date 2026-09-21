---
name: web-game-studio
description: Route browser-game work when its implementation path is unclear or the request spans multiple specialist domains.
---

# Web Game Studio

Use this skill as the umbrella for browser-game requests that span multiple domains or whose implementation path is not yet clear. Preserve an existing project's stack and conventions unless the user explicitly asks for a migration.

## Classify The Work

Choose the task mode before choosing technology:

- `create`: establish the smallest coherent, runnable game with a real core loop, clear controls, failure or reset behavior, and player feedback.
- `feature`: trace the existing architecture, define the integration points, implement the requested behavior, and check nearby regressions.
- `bugfix`: reproduce or establish evidence, identify the cause, make the smallest reliable fix, and rerun the affected flow.
- `polish`: tie visual, audio, input, or performance changes to a named player-facing improvement.
- `refactor`: preserve observable gameplay while improving internal boundaries.

Do not turn a focused feature or bug request into a redesign of the whole game.

## Route By Domain

Read only the specialist skills needed for the request:

- Architecture, engine choice, state, input, save, or performance boundaries: `../web-game-foundations/SKILL.md`
- Phaser 2D runtime work: `../phaser-2d-game/SKILL.md`
- Plain Three.js runtime work: `../three-webgl-game/SKILL.md`
- React-hosted Three.js work: `../react-three-fiber-game/SKILL.md`
- HUD, menus, overlays, responsive layout, or touch controls: `../game-ui-frontend/SKILL.md`
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
