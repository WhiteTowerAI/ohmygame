# Three.js world contract

Deliver an editable web project that realizes the expanded design. High-detail, multi-scale visual finish and a themed presentation layer are minimum requirements. The world must support an establishing view, exploration, and close inspection with a coherent visual identity. Begin scene implementation only after the completeness check in [the expansion guide](world-expansion.md) passes.

## Runtime and organization

- Provide an HTML entry, scene source, and the required assets and dependencies. Pin library versions. In a new project, prefer TypeScript with Vite and a `build` script that writes static output to `dist`; a static `index.html` with native modules also works.
- Include a renderer, scene, camera, responsive canvas, lights, and a time-based animation loop. Handle resize and device pixel ratio deliberately.
- Choose controls suited to the requested experience and explain them on the page. A walking request needs reachable paths and grounded movement; an orbit-only view is not walking.
- Give walking and turning keyboard bindings, such as WASD or arrow keys, alongside any pointer controls. Keyboard access keeps the world usable without a mouse and lets `game_use` exercise routes with real input.
- Organize named world, region, and landmark groups so a later request can target one place without rewriting unrelated regions. Keep region placement legible in the code. Do not build a generic editor or plugin framework just to make the source editable.
- Keep initial loading understandable and surface fatal load failures. Record the source and license of external assets. Never disguise a missing asset as a finished feature.
- Dispose replaced geometry, materials, textures, controls, and event listeners.

## Visual completion

Choose modeling and rendering techniques for their result. Procedural geometry can be highly detailed and external models can also fit; neither is a universal default or an excuse for a weak result. Prepare shipped GLB or glTF assets with `web-3d-asset-pipeline` when the world uses them.

- **World scale:** make boundaries, region relationships, entrances, routes, and overall composition readable. Organize foreground, midground, and background with spatial depth and intentional negative space.
- **Middle scale:** give buildings, landmarks, environmental structures, and hero subjects recognizable silhouettes, proportions, construction or anatomy, and connected parts.
- **Close range:** show material differences, surface variation, seams, wear appropriate to the setting, local components, and traces of activity. These must hold up in the intended close-up views, not only as distant silhouettes.
- **Detail distribution:** connect props and surface changes to their activity or environment. Concentrate richness near occupied areas and heroes while keeping quieter distant areas; uniform scattering and neatly cloned detail do not establish richness.
- **Visual unity:** coordinate lighting, materials, shadows, fog, color, and motion to express the theme, reveal volume, and direct attention. Preserve plausible grounding and spatial relationships.

Implement by region or core subject. Before treating one as complete, return to `.world/expanded-prompt.md` and its key visible features table to check the silhouette, important parts, material variation, and near-view details. Record the relevant code locations for those features in the existing [validation report](validation.md). Code presence is implementation evidence; runtime views must still show the promised result. If the feature cannot be seen, fix it or record the shortcoming rather than marking it visually complete.

A generic box, cylinder, or smooth tube carrying a subject's name does not realize its appearance. Blockouts can support construction, but refine or replace the parts that define the subject before claiming completion. Shared geometry and generators are useful only when they preserve each object's key differences. Express thatch, fabric, or masonry repairs through visible construction and surface cues appropriate to the style, using geometry, textures, decals, or assets as needed; a color change alone does not realize those material descriptions. Remaining placeholders, default materials, and debug panels do not count as visual finish.

When implementation requires a design change, retain the original requirement and record the replacement, reason, and impact in the design, with the remaining deviation in the validation report. A different technical method is acceptable if it preserves the intended visible result. Disclosing a missing or substituted feature does not make that requirement pass; do not erase a promise to claim agreement between design and implementation.

## Ground contact and connected support

Make contact and support credible at the intended observation scale. Distinguish a foundation that fails to meet its bearing surface from an object whose supporting structure is missing; they need different corrections.

| Placement case | Required treatment |
| --- | --- |
| Long wall, broad base, or building on uneven terrain | Check footprint boundaries, endpoints, and intermediate positions as needed for its size and terrain variation, not only the center. Use a downward foundation, stepped base, local grading with retaining walls, or raised supports consistent with the design. |
| Multiple posts or legs on a slope | Determine the bearing height at each foot and connect each support to the common upper structure; do not reuse a single center height for all feet. |
| Object on a tabletop, deck, or platform | Locate its bottom against that actual bearing surface, accounting for local coordinates, scale, and rotation rather than using bare terrain height. |
| Raised top, roof, platform, or suspended part | Build the required legs, cabinet, beams, brackets, or suspension and check that both ends connect. Scene-graph parenting alone does not establish geometric contact. |
| Imported GLB or other external model | Inspect the transformed bottom and intended contact points before placement. A bounding box can help locate the model but cannot prove that all feet of a complex model meet their supports. |

Use the actual visible terrain or bearing surface. A continuous height function can differ from the rendered terrain mesh, graded ground, or platform; use targeted ray or geometry checks at risk positions when needed. This does not require engineering load calculations, a rigid-body engine, or a generic collision framework.

Match repairs to the construction. Lowering a whole object can bury entrances or steps; moving a flat base to the highest ground point can enlarge downhill gaps. Neither is a universal fix. Preserve nearby routes and interactions, and recheck them after placement changes.

Intentional flight, magical suspension, water flotation, and supported overhangs are valid when their mechanism and spatial relationships fit the design. Do not demand ground contact from every underside. Do not hide unintended gaps with extra shadows, decorative occluders, or inaccessible review angles.

## Presentation and review views

Implement [the presentation guide](presentation.md) using the design's identity, hierarchy, copy, and responsive layout.

Provide a world overview, main-route views, hero close-ups, and views of meaningful environmental details. Reuse or adjust named close-up views to expose important surface and support details at a readable distance. Each navigation item must reach its advertised camera view or route, and the entry action must activate its designed behavior. Keep the selected view and current-location text accurate. A camera jump does not prove a route is reachable; check the actual route with appropriate grounding, scale, and occlusion.

## Interaction and performance

Define navigable bounds and handle obstructions on the requested routes. Do not trap the camera or start it inside geometry. Orbit, walking, and scenic viewpoints can coexist when they support exploration.

Observe and measure the rendered project before optimizing or reducing detail. Use that evidence to choose geometry and material reuse, instancing, batching, culling, simpler distant detail, or fewer per-frame allocations while preserving the design and features within the expected close-inspection range. Do not remove promised features or set a low-detail target on the assumption that they might affect performance. Keep post-processing optional and measurable.

## Handoff

Keep the design files in `.world/` and the runnable world in the workspace. In the final reply, give the controls, the major source locations, asset credits, known limitations, and the review evidence. A screenshot supplements the runnable world; it does not replace it.
