# Expanding an idea into a world

Use the [worked example](expansion-example.txt) as a benchmark for detail density, chapter development, and relationships between elements. Transfer its progression from layout through structures and lived-in detail to materials, atmosphere, and composition. Match the depth of resolved design decisions, not its theme, objects, place names, or chapter count. Follow the sequence below before writing scene code.

## Two passes, one design

For a new outdoor terrain world, write the same `.world/expanded-prompt.md` in two passes:

1. **Intent before the terrain image:** separate explicit requirements from inferred decisions; establish scale, north/entry direction, regions, routes, desired ridges/peaks/valleys/terraces/cliffs/water, preliminary generated subjects and provider choices, tree responsibilities, presentation, and information sources across visible areas. Resolve appearance and purpose, but leave precise coordinates and terrain-dependent attachments pending.
2. **Spatial refinement after observation:** follow [terrain-workflow.md](terrain-workflow.md) and the agent handoff to select/view references, generate/view the terrain semantic image, and record the observed spatial relationships, world frame, road-terrain decisions, watercourse-terrain decisions, and project handoff information. Update this same design with landform positions, river main stems, tributaries, lakes, beds, banks, shorelines, building groups, roads, bridge crossings, core-tree prototypes, instancing areas, and overview/route/low-angle views. Finish all terrain-dependent relationships and run the complete check below.

The agent record supports this document; it does not become a second world specification. Actual terrain, roads, and water-system relationships are built and inspected after this refinement and before mass asset placement. Local revisions update only affected decisions and do not restart the pipeline.

## 1. Inventory the world

State the user's required theme, places, functions, style, and exclusions. Distinguish these from your own choices of time, culture or fictional setting, mood, and visual identity.

List the major regions, main routes, and hero subjects first. Identify which regions each route connects and where each hero belongs. This inventory is the coverage checklist for the expansion; an overall atmosphere paragraph is not enough.

### Asset batch planning record

Keep a lightweight asset-planning table in the existing `.world/expanded-prompt.md` design record alongside the key visible features table. It is the working inventory for batch production, not a second world specification, database, or separate persistence protocol. Add one row for each major generated subject and update it as work advances:

| Field | What to record |
| --- | --- |
| Subject name | The building, bridge, vehicle, tree subject, landmark, or other major generated object. |
| Region | The world region served by the subject. |
| Subject category | Building, transportation, natural landmark, core vegetation, or another significant category. |
| Required generation | Whether the subject is a required major generated subject in the design. |
| Reference image path | The actual reference image used for generation or review. |
| Terrain dependency | Whether final terrain or a bearing surface is needed before placement can be resolved. |
| Road/water dependency | Whether placement depends on roads, riverbanks, bridges, shorelines, or another spatial relationship. |
| Can run in parallel | Whether it can be submitted with the other subjects in the current batch. |
| Integration location | The final project resource path and scene-code location. |
| Current status | `planned`, `submitted`, `generating`, `ready`, `integrated`, `validated`, or `blocked`. |

Use the dependency and parallel fields to form batches. A blocked row records the reason and does not prevent independent rows from progressing. Keep this table adjustable through the design and spatial-foundation checkpoints; do not treat it as a frozen commitment before terrain, roads, and water relationships are observed.

## 2. Develop every major region and hero subject

Organize the expansion into chapters suited to the inventory. Develop every major region and its core subjects individually; a region overview does not replace the design of its buildings, structures, or other defining subjects. Let depth follow complexity and expected viewing distance, designing open surfaces and distant regions with readable terrain, material, ecological, structural, or activity information. Resolve the dimensions below for these major items, applying support requirements where relevant; minor props do not need separate specifications:

- **Placement:** location, orientation, approximate scale, and spatial relationships to neighboring regions, routes, and subjects. For each building group, resolve how orientations follow or deliberately turn from roads, rivers, terrain edges, parcel boundaries, and public spaces; avoid an all-orthogonal grid while preserving entrances and route connections.
- **Form and structure:** distinctive silhouette, proportions, construction or anatomy, component parts, and how those parts connect or support one another.
- **Ground contact and support:** default buildings to direct contact with finalized terrain or another real bearing surface. Do not add generic concrete slabs or rectangular pads without design and terrain justification. Justify exceptional foundations, retaining walls, platforms, or raised supports from the design and terrain. Resolve, where applicable, how the subject meets sloping terrain or another bearing surface, what carries raised parts, and where suspended parts attach. Decide these relationships for the particular subject rather than applying every support type to every object.
- **Environmental fill responsibility:** for every major region, record surface type and use, expected supporting elements, distribution along boundaries or activity areas, passage/sightline exclusions, foreground/midrange/distant information, and the visible variation plan for each asset family. Specify prototype or model variation, transform ranges, material/color/maturity/wear changes, grouping, density transitions, and instancing strategy. Cover applicable water surfaces, farmland, plazas, hillsides, roads, banks, wetlands, and forest edges using the [fill rules](world-contract.md#semantic-environmental-fill). Record prototype sources, provider choice, seeds or explicit parameters, instance areas, and quantity budgets.
- **Water behavior and interaction:** for each river, lake, pond, or other water body, record the applicable wind ripples, soft reflections, shoreline/depth color changes, rain response, fish, ducks, drifting boats, and click ripples. State which effects are required, optional, omitted, or not applicable, and connect them to weather, environment, view distance, and interaction design.
- **Road continuity:** for each road, record its width, turns, entrances, bridge and plaza connections, required main routes, and clear passage space. Mark building footprints, foundations, decorations, and environmental assets that must stay outside the road space so buildings cannot cut or block the route.
- **Surroundings and activity:** nearby objects, vegetation, activities, and traces of use. Explain why they occur here and how their distribution follows the activity or environment.
- **Materials and surfaces:** material transitions, color, roughness, texture scale, local variation, wear, stains, repairs, and cleaner or protected areas where the setting calls for them.
- **Close-range detail:** visible parts, textures, edges, seams, fittings, or small objects that reward inspection, and where they sit on or around the subject.
- **Light, atmosphere, and motion:** how illumination, shadows, weather, atmospheric depth, and movement affect this item. Connect causes and effects rather than listing unrelated effects.
- **Viewing experience:** the routes and camera angles from which its important features become visible, including near views and the relationship to the arrival view.
- **Realization and acceptance:** a suitable Three.js direction for geometry, assets, materials, and motion, plus the review views that must show it. Keep implementation techniques flexible while resolving the intended appearance.

Details must become visible experience. Write appearance decisions as a part, its specific form or material, its connection to neighboring parts, and a position from which it can be seen. Locate wear at a wall foot or water-facing surface; describe where fabric sags, how its edge hangs, and where it is fastened. Generic adjectives such as "weathered," "fabric," or "detailed" do not resolve those decisions. High detail can be stylized and does not require identical weathering or clutter everywhere.

For example, "a detailed hillside tavern with a thatched roof and supplies outside" leaves the main decisions open. A resolved version could read:

> The tavern faces the walking path. Its porch roof extends farther toward the path, giving the eaves an asymmetric outline. Overlapping thatch layers expose bundled edges and lashings along the eaves; purlins connect the roof to the porch posts. A stepped foundation follows the slope, exposing a stone base on the low side. Post feet sit on this base, and entrance steps meet the path. Supplies cluster beside the posts while leaving the passage clear. The approach reveals the uneven roofline; a close side view shows thatch layers, beam-to-post joints, and the continuous wall foundation.

This demonstrates resolved relationships, not a required theme, building, or material palette.

### Choose how to model core subjects

For a new world, an actual build request authorizes generation when OhMyGame's tools and credentials are available; do not require another written authorization. Choose the available Meshy and/or Hyper3D provider(s) under the [provider rules](world-contract.md#3d-asset-provider-selection), and record the choice and reason for each major subject. When either provider or free Hyper3D access is usable, the following unified requirement applies: count Meshy and Hyper3D subjects together, complete at least 15 independent major generated subjects across at least three categories, and complete the entire required set. If no provider or free access is usable, wait for configuration unless the user explicitly declines both APIs; only then may the entire scene use procedural or existing assets. Select the required subjects from the world design before checking their number:

1. Include the main visual buildings, key landmarks, and major objects forming the core visual focal points.
2. Cover every major region with representative generated subjects from the selected provider or providers. Include all subjects needed to express each region and focal point, even when a region needs more than one.
3. Check that the set contains at least 15 independent major subjects across at least three significant object categories. If fewer are selected, add suitable major subjects from the design, never accessory parts, unrelated additions, or artificial subdivisions. Complete the entire required set even when it exceeds 15; 15 is a floor, not a cap or a measure of visual quality. Prioritize buildings and major structures in settlements; different building styles alone do not establish three object categories.

Landmark trees, giant rock arches, major rock formations or landscape rock groups, and animals expressing the world's theme or activity can qualify. Judge importance through role, placement, scale, silhouette, and visibility in overview, regional, and planned route views. Ordinary decorative trees, small corner rocks, or barely visible animals do not qualify by category alone. Few buildings do not justify a general exemption from the minimum. If the design and minimum cannot both be satisfied, record the unmet requirement without silently relaxing it or changing the user's theme.

Plan distinct core/near-view generated trees where they serve significant visual roles. Use one or two suitable generated prototypes to instance ordinary background groves, without generating every tree or counting instances as independent subjects. For a settlement, a useful starting mix is 7–9 buildings/major structures, 2–4 core trees/rocks/environmental subjects, and 2–3 bridges/towers/animals/vehicles/theme subjects, then enough other required subjects to reach at least 15. These are suggestions, not fixed category quotas; count each subject once.

In the existing key visible features table, mark required generated subjects and explain their visual role, selection reason, provider or procedural scope, and any provider-specific constraints. The selected provider must provide the main visible form of each required subject. Consider viewing distance, form and material detail, entering or passing through, opening parts, and accurate joins to roads, foundations, and neighboring structures. A complete building model with local procedural additions can preserve these connections. Generate separate parts only when the subject needs them; parts of one subject and repeated instances do not increase the count. Follow the [world contract](world-contract.md) for full counting and completion rules.

Terrain, roads, ordinary wall segments, continuous steps, precise connectors, and necessary interaction parts usually remain procedural. Do not submit door handles, ordinary signs, connectors, or other accessory details as standalone generation tasks; use procedural geometry, textures, or rendered text. Important procedural buildings outside the required generated set still need the designed appearance and close detail.

New scenes can load the selected models directly without a complete procedural first pass. Existing-scene revisions affect only requested subjects and necessary connections; they do not require 15 new models for each local change. Follow the [world contract](world-contract.md) for reference images, platform generation, and integration. Discussion, prompt-only, and plan-only tasks do not trigger paid generation; tool or resource blockers must remain explicit in `.world/validation-report.md`.

## 3. Connect the scales and the journey

Resolve the world boundary, terrain, entrances, regional connections, and navigable routes. Describe what is seen on arrival and what is discovered along each main route, including grounded movement and obstacles relevant to the requested experience. Connect world-scale composition to mid-scale buildings or subjects and then to close-range materials and traces of life.

Explain foreground, midground, background, occlusion, focal points, and information across open surfaces. Organize detail around activities, terrain edges, and ecological transitions; avoid uniform scattering or tidy repetition. Coordinate palette, light direction, shadow color, sky, fog, and motion so the regions belong to one world and the focal hierarchy stays legible. Include requested interactions without adding unrelated game systems.

Apply [the world contract's open-surface information rule](world-contract.md#open-surfaces-and-information-density) to core regions, connecting areas, and distant regions. State the specific information sources for each; an adjective such as "quiet" is not a surface design.

## 4. Design the presentation

Read [the presentation guide](presentation.md) and resolve the presentation alongside the world:

- The actual title, optional subtitle, identity label, scene description, and per-location descriptions, written in the user's language.
- Review-view names mapped to real destinations and framings or routes, the entry action and its behavior, and hints for the actual controls.
- A theme-specific palette, typography hierarchy, gradients and masks, translucent panels, and the part of the frame reserved for the hero subject.
- Narrow-viewport layout and framing changes that keep titles, navigation, hints, and the subject visible.

## 5. Check completeness before coding

Include a concise **key visible features** table in `.world/expanded-prompt.md`, organized by major region and core subject. Keep the existing subject names and use the table to record:

- The region, subject, visual role, and required form, materials, and close-range features.
- The planned provider or explicit all-procedural fallback, selection reason, visible form it supplies, procedural additions, and the unified generated-subject count/category/coverage status.
- Location, scale, orientation, foundations, entrances, route connections, and necessary interaction relationships.
- Overview or regional observation positions, subject close-ups, and applicable contact or support views.

Cover every major region, explicit user requirement, and defining feature; do not select only easy features. The table indexes the prose and does not cancel other commitments in it. Keep it in the existing design document without a new ID scheme, asset list, or separate specification. When a generated provider is available, verify at least 15 independent major generated subjects across at least three significant categories, counting Meshy and Hyper3D together, coverage of all major regions and core visual focal points, and inspectable planned views for every required subject. Repeated instances and split parts cannot fill missing slots. For new outdoor terrain worlds, verify the observed terrain semantic image and agent record have informed the second pass; resolve core trees, background instancing, open surfaces, roads and bridges against that record.

Review the inventory against the expanded chapters, feature table, and acceptance views. Each core subject should answer: what form does it have, how do its parts connect, where are its details, and from where can they be seen? If implementation would still require inventing the spatial layout, key appearance, support relationships, materials, key routes, or presentation hierarchy, return to the relevant chapter and resolve those decisions first. Ordinary modeling parameters and implementation techniques can be chosen while coding.

Judge completeness by resolved decisions and their observable consequences, never by word count, line count, chapter count, or prop count. This check is your own responsibility and does not add a user approval step.

## Two examples of transferable depth

**Abandoned desert spaceport:** arrival dunes spill through the concourse glazing; terminal ribs guide the eye to the launch apron; sand banks collect against baggage belts and the windward sides of equipment; old guidance markings lead to a grounded transport with worn thermal tiles. Sunset enters the broken roof and catches suspended dust. The terminal-to-apron path passes those details at human scale. Do not inherit the railway example's shops, sakura, or toon style.

**Forested mountain hot-spring town:** a contour-following lane links an uphill inn to stepped baths beside the stream; wet stone darkens at the waterline, timber joinery and towel shelves define the bath shelters, mineral deposits trace the overflow channels. Steam softens the distant pines while lanterns reveal nearby railings. Bridges, steps, and handrails make changes in elevation readable. Develop the chosen setting's own identity.

## Save the design

Save the design in a `.world/` directory at the workspace root. Hidden directories stay out of OhMyGame publish archives, so the design never ships with the world.

- `.world/request.md`: the user's original request, verbatim, with later revision requests appended.
- `.world/expanded-prompt.md`: the self-contained design, including the key visible features table, and the source of truth for the scene. Open with a short note separating what came from the user and what you inferred. If implementation forces a substantive design change, retain the original requirement and record the replacement, reason, and impact rather than silently dropping it. Follow [the world contract](world-contract.md) when carrying these decisions into implementation.
- `.world/scene-summary.json`: a short index of the design.
- `.world/terrain-agent-handoff.md`: for outdoor terrain worlds, the observed references/image, spatial prompt, world frame, road-terrain decisions, actual modified files, initialization entry, and deterministic parameters described in [terrain-agent-handoff.md](terrain-agent-handoff.md).

```json
{
  "theme": "...",
  "scale": "...",
  "places": [],
  "key_objects": [],
  "style": "...",
  "time": "...",
  "interactions": [],
  "user_requirements": [],
  "design_decisions": [],
  "constraints": []
}
```

The summary indexes the full design. It does not reduce delivery to finding those objects in a scene graph.
