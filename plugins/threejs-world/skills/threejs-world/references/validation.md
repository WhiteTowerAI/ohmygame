# Inspect the realized world

You own both the functional checks and the visual self-review. Judge completion against the expanded design and actual runtime evidence; no prewritten aesthetic score is required.

## Before implementation

- Apply [the expansion guide's completeness check](world-expansion.md), including the key visible features table: major regions and core subjects have resolved forms, material placement, connected parts, applicable foundations and supports, and views that can reveal them. Resolve missing design decisions before coding.
- World-scale composition, mid-scale subjects, and close-range detail connect coherently, with entrances, boundaries, foreground, midground, background, negative space, and varied density resolved.
- The page copy, theme, hierarchy, navigation destinations, entry behavior, control hints, masks, and narrow-viewport treatment are resolved against [the presentation guide](presentation.md).

## Run and operate

Use `game_use` against the current project preview. Open a session, batch related input into `act` calls, capture screenshots, and close the session in the same turn even when a check fails.

- Run the project's build, then `open` the preview. Record console errors, failed requests, and runtime failures from the returned state.
- Exercise the actual controls with real input: `press` with a `duration` to walk and turn, and `click` navigation items and the entry action by role or text. Test the main route, requested interactions, grounding, obstacles, and return or reset behavior. A programmatic camera teleport does not prove the controls work.
- Activate every navigation item and the entry action. Verify the advertised view, route, or mode, the current-location text and active state, and that control hints match the available inputs. Check that all visible text, including dynamic, loading, error, tooltip, and canvas text, is in the intended language.
- Use `wait` between captures to observe animation over time. Use `resize` to check layout changes.
- `game_use` cannot drag, scroll, or move the pointer. Do not make close inspection depend on those operations: walk and turn with supported input, and reuse or adjust named close-up views when needed to expose risk positions. Independently verify the actual walking route even when a named view helps observation. Report pointer-only behavior, such as drag-to-orbit or wheel zoom, as unverified rather than claiming it works.
- If `game_use` is unavailable, run the strongest build checks available and state plainly that the world was not visually inspected.

## Look, compare, repair

Capture and actually examine at least these kinds of views. Choose enough of them to cover the major regions and heroes in the design; these are required categories, not a screenshot quota.

| Review view | What must be visible or demonstrated |
| --- | --- |
| First screen and overview | Theme, world scale and boundary, major regions and their relationships, entrances and routes, and the main subject in one readable composition. |
| Main route | Travel through key areas at the intended viewing height, with credible ground contact, obstacles and occlusion, scale, and direction. Walk the route rather than only jumping to its endpoints. |
| Hero subject close-up | Distinctive silhouette, connected structure or anatomy, material differences, and local parts and surface detail. A distant outline is insufficient. |
| Environmental detail close-up | Supporting props, traces of use, vegetation, or material changes whose placement relates to the area's activity or environment. |
| Ground contact and support close-up | Bases of approachable buildings and long walls, post or leg feet, undersides of raised tops, roof-to-beam or beam-to-post joints, and suspension anchors where present. Frame the actual contact points closely enough to distinguish unintended gaps or missing connections. |
| Presentation | Copy, title hierarchy, location text, working navigation and entry action, accurate hints, the post-entry collapsed state, and coherent themed typography, masks, panels, and composition. |
| Narrow viewport | Readable title, navigation, entry action, and hints; a visible hero subject; intentional reflow and framing. Record the viewport used, such as 390×844. |

Start with the design's key visible features table, comparing each feature with its implementation location and a view that can actually reveal it. Cover the prose commitments as well as the table. An overview cannot establish a close-range feature or contact relationship.

For ground contact and supports, inspect risk instances across different slope directions, height changes, and connection types; a flat-ground sample does not establish that repeated structures on slopes are correct. Use human-height views for the walking experience and side or suitably low views for bottom gaps; inspect elevated suspension from an angle showing its fixed ends. Combine targeted geometry checks from [the world contract](world-contract.md) with close visual observation where needed. Judge intentional off-ground structures by their designed mechanism.

Also compare the captured pixels to the expanded design as a whole:

- Does the world communicate the intended subject, scale, atmosphere, and style?
- Are regions and landmarks arranged as designed, grounded, and reachable as required?
- Are the major silhouettes distinctive, with visible structural or anatomical detail?
- Do supporting props, materials, weathering, and environmental motion create the intended richness?
- Do lighting, color, depth, occlusion, and varied detail density make the composition readable?
- Does the page realize the design's theme and hierarchy while preserving the subject and scene controls?

Record each view and its specific issue in terms of the design: an unclear hero silhouette, missing structure, floating or intersecting objects, repetitive geometry, unintentionally empty regions, flat materials, lighting that hides volume, UI covering the subject, navigation without its promised destination, or text in the wrong language. Object names, object counts, code inspection, and a successful start cannot establish visual completion.

The required loop is: first run, actual image observation, issue recording, targeted correction, rerun, and reinspection of the changed views. After a grounding or support fix, recheck the contact points and adjacent entrances, routes, and affected interactions; after a feature fix, recheck its close view and the overall composition. When no defect is found, record that assessment rather than inventing edits. Stop when both the world and the presentation are sufficiently realized for user review, or report the specific blocker. Repeated screenshots or unaffected checks without a new finding add no evidence.

Treat a blank-looking capture as a warning, not a verdict: a uniform loading screen can look blank while a broken but noisy frame can look fine.

## Report evidence honestly

Write a concise `.world/validation-report.md` using the existing design and feature names, without a separate scoring system or ID scheme. Include:

- **Run context and completion:** the model and skill source/path used when available, whether the run completed normally, and any tool, resource, or quota interruption. Mark unknown context explicitly; an interrupted run is not a completed delivery.
- **Build and runtime checks:** compilation, console or load failures, actual controls, routes, and interactions exercised. Keep these results separate from visual checks.
- **Feature and view evidence:** a compact table mapping each key feature to its code location, inspection view and corresponding screenshot evidence, result, and any gap or limitation. Include the review categories above. Distinguish implementation present from visually confirmed; use `passed`, `deviation`, or `unverified` for visual results. Occlusion, insufficient image scale, unavailable tools, or an interrupted check mean `unverified`, not `passed`. "No issue seen" in an inadequate view does not confirm contact or support.
- **Fixes and remaining deviations:** the issue, targeted repair, affected views or routes rechecked, and result. For changed design requirements, include the original, replacement, reason, and impact. Preserve the first handoff's findings when later feedback arrives, distinguishing repairs made during normal self-review from those made only after the user or reviewer pointed out an omission. Later repair does not establish that the original self-review caught it.

State separately whether the world design is sufficiently realized and whether the presentation reaches themed quality, with remaining deviations and unverified items visible. Separate machine-confirmed facts from visual judgment and support conclusions with inspectable evidence. If you could not inspect the preview or the images, mark visual review incomplete and explain why. The final status is ready for user review or explicitly incomplete, never approved without the user's decision.
