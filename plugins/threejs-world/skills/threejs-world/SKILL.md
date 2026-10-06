---
name: threejs-world
description: Expand a short scene idea into a detailed world design, then build and visually inspect a rich, explorable Three.js world with a themed presentation layer. Use for places meant to be walked through and looked at; use web-game-studio for games built around rules, goals, or a core loop.
---

# Three.js World

Turn the user's imagined place into a rich, coherent, editable Three.js world. High-detail, multi-scale visual finish and a themed presentation layer are the minimum delivery target. A runnable procedural scene or a functional HUD alone does not meet it.

This skill covers scene and world building. When the user later wants rules, goals, scoring, or other game systems on top of the world, hand that work to `web-game-studio`.

## Design, build, inspect

1. **Understand the idea.** Preserve explicit themes, places, functions, style, and exclusions. Ask only when missing information would materially change the world; otherwise make coherent choices and record them as design decisions. Honor an explicit prompt-only or plan-only boundary when the user sets one.
2. **Expand the design before coding.** Read [the expansion guide](references/world-expansion.md), [the worked example](references/expansion-example.txt), and [the presentation guide](references/presentation.md). Inventory regions, routes, and core subjects, then develop each one's form, connections, support, surfaces, close detail, atmosphere, and review views. Match the example's depth of resolved decisions without copying its theme or chapter count. Resolve the presentation copy in the user's language. Save the design with its key visible features table, and complete the guide's check of unresolved design decisions before coding.
3. **Realize the world and presentation.** Read [the world contract](references/world-contract.md). Once the design passes its completeness check, continue straight into implementation in the same turn. Build region by region or core subject by core subject, checking each against the design and recording implementation locations before treating it as complete. Preserve distinctive forms, materials, and near-view details, with credible foundations and connected supports. Coordinate geometry, materials, light, shadow, fog, color, and motion with the theme. Placeholders, default materials, and debug panels do not count as visual finish. Measure the actual project before reducing detail for performance.
4. **Inspect, repair, and recheck.** Read [the validation guide](references/validation.md). Open the preview with `game_use`, operate its controls, and capture the overview, route, hero close-up, environmental close-up, presentation, and narrow-viewport views. Compare key design features to the pixels, including close side or low views of ground contact and support connections where needed. Record specific shortcomings, fix them, and recheck affected views and routes. Keep feature results and evidence in `.world/validation-report.md`, including deviations and unverified items. Object names, successful builds, and object counts do not establish visual completion.
5. **Deliver for review.** Summarize what was built, the controls, the review evidence, and the remaining limitations. Separate machine-confirmed checks from your visual judgment, and leave final visual approval to the user. If tools or resources prevented a check or a design feature, say so instead of declaring completion.

## Revisions

Read the existing design, the relevant code, and the user's feedback first. Update the affected part of the design and the matching named region together, preserving a record of changed requirements and their reasons as well as unrelated intent and working content. Recheck the modified views and their connections to the rest of the world.

## OhMyGame Contract

- Follow the workspace's `AGENTS.md`. In an existing project, preserve its build tool and output layout unless the user requests a migration.
- OhMyGame runs the preview. Do not leave a development server or other background process running after the turn, and do not ask the user to open a local URL. Run a build when you need to check compilation.
- Keep the world responsive inside an iframe without horizontal overflow.
- When publishing is in scope, produce static output supported by OhMyGame.
- Do not install Playwright, Puppeteer, browser binaries, or global dependencies. Keep caches, logs, and screenshots out of the shipped project.
- Never claim visual or interaction checks that were not actually performed.
