---
name: threejs-world
description: Expand a short scene idea into a detailed world design, then build and visually inspect a rich, explorable Three.js world with a themed presentation layer. Use for places meant to be walked through and looked at; use web-game-studio for games built around rules, goals, or a core loop.
---

# Three.js World

Turn the user's imagined place into a rich, coherent, editable Three.js world. High-detail, multi-scale visual finish and a themed presentation layer are the minimum delivery target. A runnable procedural scene or a functional HUD alone does not meet it.

This skill covers scene and world building. When the user later wants rules, goals, scoring, or other game systems on top of the world, hand that work to `web-game-studio`.

## Design, build, inspect

1. **Understand the idea.** Preserve explicit themes, places, functions, style, and exclusions. Ask only when missing information would materially change the world; otherwise make coherent choices and record them as design decisions. Confirm the modeling authorization and availability of OhMyGame's Meshy tools and API configuration. Honor prompt-only and plan-only boundaries; discussion and design do not authorize paid generation.
2. **Expand the design before coding.** Read [the expansion guide](references/world-expansion.md), [the worked example](references/expansion-example.txt), and [the presentation guide](references/presentation.md). Inventory regions, routes, and core subjects, then develop each one's form, connections, support, surfaces, close detail, atmosphere, and review views. For an authorized new world with Meshy tools and API configuration available, select at least six distinct major Meshy subjects covering every major region and core visual focus. Record the complete required set and modeling scope in the existing key visible features table; six is a minimum, and every required subject must be completed. Do not generate accessory parts as standalone Meshy tasks or inflate the count with repeated instances or split parts of one subject. Match the example's depth of resolved decisions without copying its theme or chapter count. Resolve the presentation copy in the user's language, save the design, and complete the guide's completeness check before coding.
3. **Realize the world and presentation.** Read [the world contract](references/world-contract.md). Once the design passes its completeness check, continue into implementation within the user's authorized scope. Meshy must realize the required subjects' main visible forms; evaluation alone does not satisfy the requirement. Follow the contract's single-object reference image, existing platform generation tools, and scene integration workflow; new scenes can use these models directly without a procedural first pass. Build region by region or core subject by core subject, checking each against the design and recording implementation locations before treating it as complete. Preserve distinctive forms, materials, and near-view details, with credible foundations and connected supports. Coordinate geometry, materials, light, shadow, fog, color, and motion with the theme. Placeholders, default materials, and debug panels do not count as visual finish. Record blocked subjects as incomplete in `.world/validation-report.md`. Measure the actual project before reducing detail for performance.
4. **Inspect, repair, and recheck.** Read [the validation guide](references/validation.md). Check the build, loading, and input, then use `game_use` for formal visual review in this order: whole world, regions and routes, major subjects, local details, then the whole world and presentation again, including narrow viewports. Fix clear overall layout or scale problems before extensive detail refinement. Compare key design features to the pixels, including close side or low views of ground contact and support connections where needed. After repairs, recheck affected close-ups, connections, routes, and overall views. Check Meshy count, coverage, the full required set, and visual quality separately. Keep findings and evidence in `.world/validation-report.md`, including deviations and unverified items. Object names, successful builds, and object counts do not establish visual completion.
5. **Deliver for review.** Provide the runnable world entry, necessary controls, and useful source locations. Keep detailed checks, generation and repair history, evidence, and limitations in `.world/validation-report.md` rather than repeating them in the final reply. A concise handoff does not make unmet requirements complete; if the world cannot build or open, state that no usable result is available. Leave final visual approval to the user.

## Revisions

Read the existing design, relevant code, and feedback first. Change only affected subjects and necessary connections, preserving unrelated regions and functions. Update the design and validation records, including changed requirements and reasons, and recheck appearance, routes, and interactions. A local revision does not require rebuilding the world or generating six new models. When the request involves model replacement, follow the [world contract](references/world-contract.md): load and inspect the new model before removing the old one, handle unused resources, and retain comparable before/after views under the [validation guide](references/validation.md).

## OhMyGame Contract

- Follow the workspace's `AGENTS.md`. In an existing project, preserve its build tool and output layout unless the user requests a migration.
- OhMyGame runs the preview. Do not leave a development server or other background process running after the turn, and do not ask the user to open a local URL. Run a build when you need to check compilation.
- Keep the world responsive inside an iframe without horizontal overflow.
- When publishing is in scope, produce static output supported by OhMyGame.
- Do not install Playwright, Puppeteer, browser binaries, or global dependencies. Keep caches, logs, and screenshots out of the shipped project.
- Never claim visual or interaction checks that were not actually performed.
