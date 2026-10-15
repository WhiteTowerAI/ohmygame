# Inspect the realized world

You own both the functional checks and the visual self-review. Judge completion against the expanded design and actual runtime evidence; no prewritten aesthetic score is required.

## Before implementation

- Apply [the expansion guide's completeness check](world-expansion.md), including the key visible features table: major regions and core subjects have resolved forms, material placement, connected parts, applicable foundations and supports, and views that can reveal them. Resolve missing design decisions before coding.
- Check task scope and actual Meshy/Hyper3D/free-Hyper3D availability, platform-reported credential status, quota, and whether the user explicitly declined both APIs under the [provider rules](world-contract.md#3d-asset-provider-selection), without reading credentials. If any generation provider is available, check at least 15 independent major generated subjects across at least three significant categories, counting Meshy and Hyper3D together, with representatives of every major region and coverage of the main visual buildings, key landmarks, and core focal points. Include every required subject even when the set exceeds 15. Each needs a selection reason, provider scope, placement and connection decisions, and overview or regional, close-up, and applicable contact views. Apply the [world contract's counting rules](world-contract.md); accessory tasks, repeated instances, and split parts cannot fill missing slots. If no provider or free Hyper3D access is usable and the user has not declined, stop and direct configuration to `Providers & Models`. Only an explicit refusal plus no provider/free access permits the all-procedural fallback; record that exception.
- For new outdoor terrain worlds, confirm actual observation of 1–3 selected references and the generated terrain semantic image, `borrow/avoid` records, the agent handoff, and the second pass in the same expanded prompt under [terrain-workflow.md](terrain-workflow.md). Paths or tool success alone do not prove observation. Confirm the integrated terrain-road-water system is inspected before mass asset placement.
- World-scale composition, mid-scale subjects, and close-range detail connect coherently, with entrances, boundaries, foreground, midground, background, designed open surfaces, and varied density resolved.
- The page copy, theme, hierarchy, navigation destinations, entry behavior, control hints, masks, and narrow-viewport treatment are resolved against [the presentation guide](presentation.md).

## Run and operate

Use `game_use` against the current project preview. Open a session, batch related input into `act` calls, capture screenshots, and close the session in the same turn even when a check fails. Start with build, resource loading, runtime errors, and basic input availability; perform the route, subject, and presentation checks below at their corresponding formal review stages.

- Run the project's build, then `open` the preview. Record console errors, failed requests, and runtime failures from the returned state.
- For generated or reused models, verify that GLB files and required dependencies are included in the static output and resolve from its asset paths. Confirm actual model and texture loading in the running scene; source-file presence, generation success, or a development-only `assets/generated/` URL does not establish delivery. If loading from the static output cannot be exercised, record that check as unverified.
- Exercise the actual controls with real input: `press` with a `duration` to walk and turn, and `click` navigation items and the entry action by role or text. Test the main route, requested interactions, grounding, obstacles, and return or reset behavior. A programmatic camera teleport does not prove the controls work.
- Activate every navigation item and the entry action. Verify the advertised view, route, or mode, the current-location text and active state, and that control hints match the available inputs. Check that all visible text, including dynamic, loading, error, tooltip, and canvas text, is in the intended language.
- Use `wait` between captures to observe animation over time. Use `resize` to check layout changes.
- `game_use` cannot drag, scroll, or move the pointer. Do not make close inspection depend on those operations: walk and turn with supported input, and reuse or adjust named close-up views when needed to expose risk positions. Independently verify the actual walking route even when a named view helps observation. Report pointer-only behavior, such as drag-to-orbit or wheel zoom, as unverified rather than claiming it works.
- If `game_use` is unavailable, run the strongest build checks available and record in `.world/validation-report.md` that visual review is incomplete and why.

## Batch-oriented observation and repair

Use the soft checkpoints and batch records from [the expansion guide](world-expansion.md) while validating. Prefer one reused preview session for a ready integration batch. Combine adjacent movement, waits, and screenshots in the same round of actions so that each observation covers several relevant views or regions. First collect the issues visible in that round; do not stop to repair the first isolated problem before checking the rest of the batch.

Group findings into:

1. overall composition and focal hierarchy;
2. terrain, roads, and water-system relationships;
3. asset grounding, supports, and placement;
4. materials and close-range detail;
5. presentation and themed UI.

Repair the broader composition and spatial relationships before local detail. After each group, recheck only the affected views, routes, entrances, contact points, and interactions. Keep independent asset failures marked as `blocked` in the existing report while other batch members continue. Once all local groups are addressed, run the full five-stage review in [Look, compare, repair](#look-compare-repair) one final time, including the narrow-viewport and presentation checks. This batching changes the observation cadence only; it never removes major-subject, road-clearance, grounding, narrow-viewport, or final full-review requirements.

## Semantic environmental fill checks

Before final review, confirm the [fill pass](world-contract.md#semantic-environmental-fill) happened after terrain, roads, visible water, major assets, and key buildings were complete. Observe panorama, overhead, midrange, routes, and low angles before additions; identify each region's use, surface type, current information, and deficiencies. After additions, repeat panorama, route, midrange, low-angle, and local-contact inspection. Every major visible region, including low-density open water, farmland, plaza centers, hillsides, roads, banks, wetlands, and distant areas, must have appropriate environmental and transition information.

Check distribution against function and ecology, passage and entrance clearance, bridge/water relationships, and main sightlines. Check that buildings are not all aligned to one orthogonal grid and that their orientations respond to roads, rivers, terrain boundaries, parcels, or public spaces while keeping entrances and routes legible. Check that each environmental asset family has visible variation in prototype, scale, pose, rotation, material, color, maturity, wear, grouping, or density; shared instancing must not create a copy-paste appearance. Verify stable seeds or explicit parameters, quantity budgets, instancing for repeated assets, resource/loading paths, and measured initialization/rendering performance. Confirm bulk procedural geometry is not rebuilt every frame. Record deficient regions, added asset types, providers, distributions, parameters, quantities, before/after evidence, and unresolved findings in the existing report; asset count alone does not establish fullness.

## Water and road checks

During the same visual review, check water bodies against their design:

- wind ripples, soft reflections, shoreline/depth color changes, rain response, fish, ducks, drifting boats, and click ripples appear when required;
- effects fit the water body, weather, environment, viewing distance, and interaction design;
- omitted or inapplicable effects are recorded as such rather than treated as failures;
- animation and interaction remain within the measured performance budget.

Check road continuity and building clearance:

- no building footprint enters a road or occupies its passage space;
- no foundation, step, platform, decoration, or environmental asset cuts or blocks a road;
- each required building entrance connects to a road;
- roads connect building groups, bridges, plazas, and major regions and remain physically traversable;
- route checks use actual movement and turning, not only a visible road material or line;
- keep enough clear space for the intended movement and repair any interruption before delivery.

Record water findings and road obstructions in the existing validation report, including the affected view or route and the recheck result.

## Look, compare, repair

Perform formal scene review in the following order, recording views, findings, and repairs in `.world/validation-report.md`. Choose enough overview and supplementary views to cover the world, then inspect every major region and required subject; these are coverage requirements, not a screenshot quota.

| Review stage | What must be visible or demonstrated |
| --- | --- |
| 1. Whole world | First screen, overview, and supplementary angles showing layout, scale, boundary, all major regions and their relationships, entrances, routes, focal hierarchy, theme, lighting, foreground/midground/background, and varied density. Repair obvious layout errors, scale imbalance, or missing major regions before extensive local refinement. |
| 2. Regions and routes | Inspect each region against the inventory: completeness, representative subjects, regional connections, entrances, and main routes. Walk through the key areas at the intended height with real input, checking ground contact, obstacles, occlusion, scale, and direction; jumping to endpoints is insufficient. |
| 3. Major subjects | Inspect every required generated subject's silhouette, proportions, connected structure or anatomy, materials, important parts, and design fidelity at readable distances. Check the required set, qualified count, regional coverage, and focal-point coverage. Other important buildings also need the designed appearance and close detail; rough placeholders do not pass. |
| 4. Local details | Inspect textures, visible back sides, thin parts, supporting props, traces of use, vegetation, and material changes. Use close side, low, or other suitable views of building and wall bases, steps, post or leg feet, raised undersides, roof-to-beam and beam-to-post joints, and suspension anchors. Reveal gaps, missing support, floating or intersecting parts, and differences across slope directions, terrain heights, and connection types. |
| 5. Whole world and presentation again | Recheck overall composition, region relationships, and routes affected by local repairs. Inspect copy, title hierarchy, location text, every navigation item and entry action, accurate hints, the post-entry collapsed state, themed typography, masks, and panels. Check narrow-viewport reflow and framing with readable controls and a visible hero subject; record the viewport, such as 390×844. |

Resolve clear overall problems before large-scale local polishing. Local observation needed to diagnose an overall problem is allowed, as are model-loading and individual-subject checks during construction. Fix presentation or narrow-viewport issues when found, and still check their complete final state in the last stage.

Within those same five stages, also check:

1. **Whole world / overhead:** visible ridge, peak, valley, terrace, river main stem, tributary, lake, bank, shoreline, and region relationships agree with the agent record and semantic image's design intent, without pixel matching.
2. **Regions/routes:** core, connecting and distant regions form a continuous environment; roads, watercourses, bridges, and building groups follow the integrated terrain-road-water design and actual support surfaces.
3. **Major subjects:** when any generation provider is available, at least 15 qualified independent generated subjects across three significant categories, with Meshy and Hyper3D subjects combined and every required region and subject covered. Instanced trees and model variants do not increase the count.
4. **Local details:** inspect core-tree roots/bases, building perimeters, entrances, wall feet, and any justified foundations, both bridge approaches, riverbeds, banks, shorelines, visible water contacts, and slope contacts against the rendered ground or relevant support surface.
5. **Whole world again:** no unresolved large single-plane, single-material or information-poor areas. Judge rivers, fields, grass slopes and distant areas by [their designed information](world-contract.md#open-surfaces-and-information-density), not uniform prop density.

Keep visual review as the acceptance method. Do not replace it with old WorldClaw numerical validation or impose height ranges, mean/road slopes, regional relief, material weights, mask coverage or topology thresholds. Use numbers only to diagnose a concrete defect or establish implementation correctness.

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

The required loop is: first run, actual image observation in the order above, issue recording, targeted correction, rerun, and reinspection of the affected views. After a local fix, recheck the corresponding close-up, relevant contact points, adjacent entrances and routes, affected interactions, and affected overall views. Return to the appropriate earlier stage if a new overall problem appears. When no defect is found, record that assessment rather than inventing edits. Stop when the world, all required subjects, and presentation meet their requirements for user review, or record the specific blocker and incomplete status. Repeated screenshots or unaffected checks without a new finding add no evidence.

Treat a blank-looking capture as a warning, not a verdict: a uniform loading screen can look blank while a broken but noisy frame can look fine.

## Review generated subjects and replacements

During the major-subject and local-detail stages, compare every required generated subject to its design and available reference image in the actual scene. Apply the [world contract's completion rules](world-contract.md) and, whenever any generation provider is available, assess the unified minimum qualified count, Meshy/Hyper3D combined category and regional coverage, the entire required set, and visual quality. 15 completed subjects do not finish a set of eighteen, and 15 subjects concentrated in one region do not establish coverage. For each counted subject, confirm that its selected provider supplies the main visible form and that provenance, final-scene use, static-output loading, and visual and spatial checks support its inclusion. Keep blocked or unverified subjects out of the completed count; record the subject, cause, and unmet requirement rather than treating a fallback as passed.

Inspect each subject's overall silhouette, dimensions, orientation, materials, and required close detail, including visible back sides and thin parts. Check for texture distortion, missing features, and baked shadows that conflict with scene lighting. Keep reference-image quality, generated-model quality, and scene-integration findings distinct so repairs address the cause. Landmark natural forms and theme-defining animals must have the major visual role and planned visibility specified in the design; an object name or category alone does not qualify them. Important procedural buildings remain subject to the same visual-quality checks.

For buildings, confirm direct contact with the finalized terrain or other designed bearing surface by inspecting perimeter, wall feet, entrances, and any porch or step contacts. Record why any foundation, retaining wall, platform, or raised support is needed. Automatically repeated, unjustified, or decorative slabs, footprint pads, square bases, or generic platforms are defects requiring repair; a design-justified foundation is allowed, and foundation presence alone is never a completion criterion. Check entrance-to-road connections and surrounding passage space. Exercise entering, passing through, or opening parts only when required by the design; exterior appearance or a doorway texture cannot establish a usable interior. Check relevant collision behavior independently of the detailed visible mesh. Include the overview, hero close-up, contact points, main route, and narrow-viewport evidence in the existing review categories.

For an existing-scene replacement, retain representative before/after views with matching camera framing and recheck affected routes and interactions. For a new scene, judge against the design without manufacturing a rough predecessor just for comparison. State which path was actually exercised; testing a new scene does not validate replacement behavior. Preserve any generation or integration blocker and unmet design requirement in the report rather than treating a fallback as a passed Meshy feature.

## Report evidence honestly

Concentrate detailed validation results in the existing `.world/validation-report.md`, using the design and feature names without a separate user report, scoring system, ID scheme, or per-object approval process. Include:

- **Run context and completion:** the model and skill source/path used when available, whether the run completed normally, and any tool, resource, or quota interruption. Mark unknown context explicitly; an interrupted run is not a completed delivery.
- **Build and runtime checks:** compilation, console or load failures, actual controls, routes, and interactions exercised. Keep these results separate from visual checks.
- **Generated asset evidence, when applicable:** actual Meshy/Hyper3D/free-Hyper3D availability, credential-configuration status without secret values, explicit user refusal status, fallback mode and reason, provider selection and quota limitations, combined subject count/category/region status, required subject names, reference-image and model paths, source/provenance and asset credits, final scene code reference locations, and static-output inclusion and loading results. Identify reused assets and unavailable generation history, tool or format blockers, and whether the new-scene or replacement path was exercised. Keep this in the existing report rather than a separate asset ledger.
- **Terrain evidence, when applicable:** paths and actual observations of selected references and the generated terrain semantic image; agent handoff decisions, image-to-scene findings, integrated terrain-road-water inspection before mass placement, open-surface coverage, and ground/support contact views. Reuse the handoff record; no separate image approval database or terrain scoring system.
- **Environmental fill:** region surface types and uses, missing information, additions and distribution rules, providers, stable seeds/parameters, quantities and instancing regions, resource/loading paths, initialization/rendering measurements, visible asset-family variation strategy, and before/after panorama, route, midrange, low-angle and local-contact results. Record any architectural orientation decisions and their road/river/terrain rationale. Include building contact decisions and repairs to unexplained generic bases.
- **Generated-subject acceptance, when a provider is available:** planned and actual combined Meshy/Hyper3D qualified counts, completion of the full required set, category count, and coverage of each major region and core visual focus. If the explicit-refusal all-procedural exception applies, record that exception and assess the procedural scene against the design instead. Record count, coverage, required-set completion, and visual quality separately, with incomplete subjects and the specific cause or unmet check. Neither generation success nor meeting the count cancels a missing region, required subject, or visual feature.
- **Feature and view evidence:** a compact table mapping each key feature to its code location, inspection view and corresponding screenshot evidence, result, and any gap or limitation. Include all five formal review stages, from the whole world through regional, subject, and local checks to the final overall and presentation review. Distinguish implementation present from visually confirmed; use `passed`, `deviation`, or `unverified` for visual results. Occlusion, insufficient image scale, unavailable tools, or an interrupted check mean `unverified`, not `passed`. "No issue seen" in an inadequate view does not confirm contact or support.
- **Fixes and remaining deviations:** the issue, targeted repair, affected views or routes rechecked, and result. For changed design requirements, include the original, replacement, reason, and impact. Preserve the first handoff's findings when later feedback arrives, distinguishing repairs made during normal self-review from those made only after the user or reviewer pointed out an omission. Later repair does not establish that the original self-review caught it.

In the report, state separately whether the world design is sufficiently realized and whether the presentation reaches themed quality, with remaining deviations and unverified items visible. Separate machine-confirmed facts from visual judgment and support conclusions with inspectable evidence. If you could not inspect the preview or the images, mark visual review incomplete and explain why. The final status is ready for user review or explicitly incomplete, never approved without the user's decision.

Keep the final reply focused on the runnable world entry, necessary controls, and useful source locations, without repeating the technical checks, generation history, or repair list. Omitting those details from the reply does not permit an incomplete result to be called complete. If the world cannot build or open, state that no usable result is available; final visual approval remains with the user.
