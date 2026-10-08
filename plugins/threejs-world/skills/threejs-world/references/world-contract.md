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

Follow [the expansion guide](world-expansion.md) to select the required Meshy subjects. For an authorized new world with OhMyGame's Meshy tools and API configuration available, complete at least six distinct major subjects covering every major region and core visual focus, and complete the entire required set even when it is larger. Meshy must supply their main visible forms; evaluating it and choosing procedural modeling for all subjects does not meet this requirement. Three.js still owns scene organization, layout, rendering, and interaction. Prepare shipped GLB or glTF assets with `web-3d-asset-pipeline` when the world uses them.

- **World scale:** make boundaries, region relationships, entrances, routes, and overall composition readable. Organize foreground, midground, and background with spatial depth and intentional negative space.
- **Middle scale:** give buildings, landmarks, environmental structures, and hero subjects recognizable silhouettes, proportions, construction or anatomy, and connected parts.
- **Close range:** show material differences, surface variation, seams, wear appropriate to the setting, local components, and traces of activity. These must hold up in the intended close-up views, not only as distant silhouettes.
- **Detail distribution:** connect props and surface changes to their activity or environment. Concentrate richness near occupied areas and heroes while keeping quieter distant areas; uniform scattering and neatly cloned detail do not establish richness.
- **Visual unity:** coordinate lighting, materials, shadows, fog, color, and motion to express the theme, reveal volume, and direct attention. Preserve plausible grounding and spatial relationships.

Implement by region or core subject. Before treating one as complete, return to `.world/expanded-prompt.md` and its key visible features table to check the silhouette, important parts, material variation, and near-view details. Record the relevant code locations for those features in the existing [validation report](validation.md). Code presence is implementation evidence; runtime views must still show the promised result. If the feature cannot be seen, fix it or record the shortcoming rather than marking it visually complete.

A generic box, cylinder, or smooth tube carrying a subject's name does not realize its appearance. Blockouts can support construction, but refine or replace the parts that define the subject before claiming completion. Shared geometry and generators are useful only when they preserve each object's key differences. Express thatch, fabric, or masonry repairs through visible construction and surface cues appropriate to the style, using geometry, textures, decals, or assets as needed; a color change alone does not realize those material descriptions. Remaining placeholders, default materials, and debug panels do not count as visual finish.

When implementation requires a design change, retain the original requirement and record the replacement, reason, and impact in the design, with the remaining deviation in the validation report. A different technical method is acceptable if it preserves the intended visible result and the required Meshy contribution. Disclosing a missing or substituted feature does not make that requirement pass; do not erase a promise to claim agreement between design and implementation.

### Count completed Meshy subjects

- Count distinct major subjects, not scene nodes, GLB files, downloads, or API calls. Repeated placements, scale or color variants of the same model, and regenerated candidates do not add subjects. A subject split into several generated parts for production or interaction still counts as one.
- Meshy must realize the subject's main visible form. A generated ornament attached to a procedural building does not make that building a Meshy subject. Do not generate door handles, ordinary signs, connectors, or other accessory details as standalone Meshy tasks. Those details may occur naturally within a complete generated subject.
- Generation or copying a file into the project is insufficient. Count a subject as complete only after integration into the final scene, confirmed model and texture loading from the final static output, and the relevant visual and spatial checks. Temporary blockouts and unverified subjects do not count as completed.
- Suitable existing Meshy models may be reused with their actual provenance recorded. Do not label an ordinary GLB of unknown or other origin as a Meshy result.
- Check the minimum count, region and focal-point coverage, completion of every required subject, and visual quality separately; one cannot compensate for another. Important procedural buildings outside the required set must also meet the design and cannot remain rough placeholders.

## Meshy reference images and generation

Use OhMyGame's existing `generate_image` and `generate_3d_asset` tools for the required subjects, or reuse suitable existing reference images or models under the counting rules above. Follow the current user authorization and platform rules for generation; discussion, prompt-only, and plan-only tasks do not authorize paid generation.

Prepare and inspect a reference image before submitting it:

- Prefer a plain white background, the complete subject in frame, and clear edges with no cropped key parts. White describes the background; the subject keeps its designed colors and materials.
- Show one asset per image. A building's roof, windows, porch, and base belong to it; surrounding roads, trees, and other buildings do not.
- Specify proportions, materials, palette, style, and indispensable features from the current design. Choose an informative view, such as a front three-quarter view showing the facade, side, and roof, without strong perspective or excessive occlusion.
- Avoid text, watermarks, complex backgrounds, collages, and multi-view sheets. Respect the platform tool's single-image input rather than packing several views into one image.
- Check completeness and key features before generation. An attractive reference does not establish correct unseen sides, interiors, or usable entrances in the resulting model.

Confirm tool availability, credentials, and that the project-local image exists in a supported actual format. `generate_image` may return WebP, while `generate_3d_asset` accepts PNG/JPEG. If conversion is needed, use available local image processing to change the actual encoding; renaming the extension is insufficient. Pass the compatible project-local path as `imagePath` to `generate_3d_asset` and reuse the platform's request, waiting, download, and save behavior.

The current agent tool exposes only `imagePath`; leave model version, face count, topology, textures, and PBR to the platform defaults. Do not duplicate or override that configuration in the skill, assume a canvas node's custom settings are inherited, or add a Meshy client, credential store, or background task system. Do not impose fixed generation rounds, automatic batch retries, or a separate per-object approval workflow.

Readable API configuration does not prove that generation will succeed. If tools, credentials, format conversion, generation, download, or integration fail, record the affected subject, specific blocker, and incomplete state in `.world/validation-report.md`. Do not count a temporary substitute or lower the requirements to mark a failure as passed. Distinguish reference-image defects, generated-model defects, and integration defects when choosing a repair; changing model versions, increasing face counts, or relaxing design requirements is not evidence of success. Meshy quality, including back sides, thin parts, and required interiors, must be checked in the scene.

## Integrate or replace generated models

For new scenes, load selected models directly. Use temporary blockouts only when needed to check layout, dimensions, or passage space; they are not the final visual delivery. For an existing scene, first read the affected design and code to establish the subject's named region, location, target size, orientation, and interaction relationships. Load and check the replacement before removing the original visible geometry.

- Reuse the project's GLB/glTF loading approach and existing asset preparation guidance; do not introduce a general asset framework.
- Set scale, orientation, origin, and intended contact points. Inspect foundations, steps, and porches against the actual terrain or bearing surface using the grounding requirements below; bounding boxes alone do not establish contact.
- Check building entrances against connecting roads, surrounding passage space, and adjacent structures. Provide usable interiors, doors, and interaction parts when the design requires entering, passing through, or opening them. An exterior shell or a painted doorway does not prove a required interior is usable.
- Coordinate materials, textures, lighting, and shadows with the scene. Inspect floating or intersecting parts, distorted proportions, and conflicting baked shadows at the intended viewing distance.
- Reuse simple collision shapes where the existing experience needs them. Do not automatically use the detailed visible mesh as collision geometry or add a physics system.
- Copy GLB files and required dependencies from `assets/generated/` into the project's buildable asset paths: `src/` for imports or `public/` for fixed URLs in the standard project layout. Reference those copies from scene code and verify that the final static output can load them; a preview-only URL into `assets/generated/` is insufficient.
- Preserve unrelated regions and existing functionality. Remove only geometry and resources made unused by this replacement, disposing them without breaking shared users. If replacement fails, keep the original recoverable and report the incomplete state.

Record the existing subject name, reference image and model paths, final scene reference location, and asset provenance in `.world/validation-report.md`, using the design's key visible features table as the required subject list. For reused models, record the available source and any unavailable reference-image history honestly. Do not add a database or separate manifest protocol. Generation success alone does not establish visual completion; follow the [validation guide](validation.md).

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

Keep the design files in `.world/` and the runnable world in the workspace. In the final reply, provide the world entry, necessary controls, and useful source locations. Keep asset credits, detailed validation evidence, generation and repair history, and remaining deviations or unverified items in `.world/validation-report.md`; do not repeat a technical checklist in the reply. This concise handoff does not turn unmet requirements into completion. If the world cannot build or open, state that no usable result is available. A screenshot supplements the runnable world; it does not replace it. Final visual approval belongs to the user.
