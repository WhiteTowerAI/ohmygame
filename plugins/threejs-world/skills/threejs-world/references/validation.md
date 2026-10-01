# Inspect the realized world

You own both the functional checks and the visual self-review. Judge completion against the expanded design and actual runtime evidence; no prewritten aesthetic score is required.

## Before implementation

- Apply [the expansion guide's completeness check](world-expansion.md): every major region, route, and hero subject is developed through placement, connected structure, surroundings and activity, materials, close detail, atmosphere and motion, viewing experience, and realization and acceptance views.
- World-scale composition, mid-scale subjects, and close-range detail connect coherently, with entrances, boundaries, foreground, midground, background, negative space, and varied density resolved.
- The page copy, theme, hierarchy, navigation destinations, entry behavior, control hints, masks, and narrow-viewport treatment are resolved against [the presentation guide](presentation.md).

## Run and operate

Use `game_use` against the current project preview. Open a session, batch related input into `act` calls, capture screenshots, and close the session in the same turn even when a check fails.

- Run the project's build, then `open` the preview. Record console errors, failed requests, and runtime failures from the returned state.
- Exercise the actual controls with real input: `press` with a `duration` to walk and turn, and `click` navigation items and the entry action by role or text. Test the main route, requested interactions, grounding, obstacles, and return or reset behavior. A programmatic camera teleport does not prove the controls work.
- Activate every navigation item and the entry action. Verify the advertised view, route, or mode, the current-location text and active state, and that control hints match the available inputs. Check that all visible text, including dynamic, loading, error, tooltip, and canvas text, is in the intended language.
- Use `wait` between captures to observe animation over time. Use `resize` to check layout changes.
- `game_use` cannot drag, scroll, or move the pointer. Report pointer-only behavior, such as drag-to-orbit or wheel zoom, as unverified rather than claiming it works.
- If `game_use` is unavailable, run the strongest build checks available and state plainly that the world was not visually inspected.

## Look, compare, repair

Capture and actually examine at least these kinds of views. Choose enough of them to cover the major regions and heroes in the design; these are required categories, not a screenshot quota.

| Review view | What must be visible or demonstrated |
| --- | --- |
| First screen and overview | Theme, world scale and boundary, major regions and their relationships, entrances and routes, and the main subject in one readable composition. |
| Main route | Travel through key areas at the intended viewing height, with credible ground contact, obstacles and occlusion, scale, and direction. Walk the route rather than only jumping to its endpoints. |
| Hero subject close-up | Distinctive silhouette, connected structure or anatomy, material differences, and local parts and surface detail. A distant outline is insufficient. |
| Environmental detail close-up | Supporting props, traces of use, vegetation, or material changes whose placement relates to the area's activity or environment. |
| Presentation | Copy, title hierarchy, location text, working navigation and entry action, accurate hints, the post-entry collapsed state, and coherent themed typography, masks, panels, and composition. |
| Narrow viewport | Readable title, navigation, entry action, and hints; a visible hero subject; intentional reflow and framing. Record the viewport used, such as 390×844. |

Compare the captured pixels to the expanded design:

- Does the world communicate the intended subject, scale, atmosphere, and style?
- Are regions and landmarks arranged as designed, grounded, and reachable as required?
- Are the major silhouettes distinctive, with visible structural or anatomical detail?
- Do supporting props, materials, weathering, and environmental motion create the intended richness?
- Do lighting, color, depth, occlusion, and varied detail density make the composition readable?
- Does the page realize the design's theme and hierarchy while preserving the subject and scene controls?

Record each view and its specific issue in terms of the design: an unclear hero silhouette, missing structure, floating or intersecting objects, repetitive geometry, unintentionally empty regions, flat materials, lighting that hides volume, UI covering the subject, navigation without its promised destination, or text in the wrong language. Object names, object counts, code inspection, and a successful start cannot establish visual completion.

The required loop is: first run, actual image observation, issue recording, targeted correction, rerun, and reinspection of the changed views. When no defect is found, record that assessment rather than inventing edits. Stop when both the world and the presentation are sufficiently realized for user review, or report the specific blocker. Repeated screenshots without a new finding add no evidence.

Treat a blank-looking capture as a warning, not a verdict: a uniform loading screen can look blank while a broken but noisy frame can look fine.

## Report evidence honestly

Write a concise `.world/validation-report.md` covering the runtime results, the visual observations for each review category, the fixes and recheck results, material deviations from the design, and known limitations. State separately whether the world design is sufficiently realized and whether the presentation reaches themed quality. A short table helps when several features need comparison; do not build a large scoring framework.

Separate machine-confirmed facts from your visual judgment. If you could not inspect the preview or the images, mark visual review incomplete and explain why. The final status is ready for user review or explicitly incomplete, never approved without the user's decision.
