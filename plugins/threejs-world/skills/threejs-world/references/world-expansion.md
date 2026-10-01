# Expanding an idea into a world

Use the [worked example](expansion-example.txt) as a benchmark for detail density, chapter development, and relationships between elements. Transfer its progression from layout through structures and lived-in detail to materials, atmosphere, and composition. Match the depth of resolved design decisions, not its theme, objects, place names, or chapter count. Follow the sequence below before writing scene code.

## 1. Inventory the world

State the user's required theme, places, functions, style, and exclusions. Distinguish these from your own choices of time, culture or fictional setting, mood, and visual identity.

List the major regions, main routes, and hero subjects first. Identify which regions each route connects and where each hero belongs. This inventory is the coverage checklist for the expansion; an overall atmosphere paragraph is not enough.

## 2. Develop every major region and hero subject

Organize the expansion into chapters suited to the inventory and develop each item individually. Resolve all of these dimensions for each major region or hero subject:

- **Placement:** location, orientation, approximate scale, and spatial relationships to neighboring regions, routes, and subjects.
- **Form and structure:** distinctive silhouette, proportions, construction or anatomy, component parts, and how those parts connect or support one another.
- **Surroundings and activity:** nearby objects, vegetation, activities, and traces of use. Explain why they occur here and how their distribution follows the activity or environment.
- **Materials and surfaces:** material transitions, color, roughness, texture scale, local variation, wear, stains, repairs, and cleaner or protected areas where the setting calls for them.
- **Close-range detail:** visible parts, textures, edges, seams, fittings, or small objects that reward inspection, and where they sit on or around the subject.
- **Light, atmosphere, and motion:** how illumination, shadows, weather, atmospheric depth, and movement affect this item. Connect causes and effects rather than listing unrelated effects.
- **Viewing experience:** the routes and camera angles from which its important features become visible, including near views and the relationship to the arrival view.
- **Realization and acceptance:** a suitable Three.js direction for geometry, assets, materials, and motion, plus the review views that must show it. Keep implementation techniques flexible while resolving the intended appearance.

Details must become visible experience. Explain how elements meet, overlap, weather, or support an activity; do not substitute generic adjectives or unrelated props for these decisions. High detail can be stylized and does not require identical weathering or clutter everywhere.

## 3. Connect the scales and the journey

Resolve the world boundary, terrain, entrances, regional connections, and navigable routes. Describe what is seen on arrival and what is discovered along each main route, including grounded movement and obstacles relevant to the requested experience. Connect world-scale composition to mid-scale buildings or subjects and then to close-range materials and traces of life.

Explain foreground, midground, background, occlusion, focal points, and intentional negative space. Concentrate detail around activities and hero subjects, with quieter distant areas; avoid uniform scattering or tidy repetition. Coordinate palette, light direction, shadow color, sky, fog, and motion so the regions belong to one world and the focal hierarchy stays legible. Include requested interactions without adding unrelated game systems.

## 4. Design the presentation

Read [the presentation guide](presentation.md) and resolve the presentation alongside the world:

- The actual title, optional subtitle, identity label, scene description, and per-location descriptions, written in the user's language.
- Review-view names mapped to real destinations and framings or routes, the entry action and its behavior, and hints for the actual controls.
- A theme-specific palette, typography hierarchy, gradients and masks, translucent panels, and the part of the frame reserved for the hero subject.
- Narrow-viewport layout and framing changes that keep titles, navigation, hints, and the subject visible.

## 5. Check completeness before coding

Review the inventory against the expanded chapters and acceptance views. If implementation would still require inventing the spatial layout, hero structure, material relationships, key routes, or presentation hierarchy, the expansion has not passed. Return to the relevant chapter and resolve those decisions first. Choosing implementation techniques while coding is expected; inventing missing scene design is not.

Judge completeness by resolved decisions and their observable consequences, never by word count, chapter count, or prop count. This check is your own responsibility and does not add a user approval step.

## Two examples of transferable depth

**Abandoned desert spaceport:** arrival dunes spill through the concourse glazing; terminal ribs guide the eye to the launch apron; sand banks collect against baggage belts and the windward sides of equipment; old guidance markings lead to a grounded transport with worn thermal tiles. Sunset enters the broken roof and catches suspended dust. The terminal-to-apron path passes those details at human scale. Do not inherit the railway example's shops, sakura, or toon style.

**Forested mountain hot-spring town:** a contour-following lane links an uphill inn to stepped baths beside the stream; wet stone darkens at the waterline, timber joinery and towel shelves define the bath shelters, mineral deposits trace the overflow channels. Steam softens the distant pines while lanterns reveal nearby railings. Bridges, steps, and handrails make changes in elevation readable. Develop the chosen setting's own identity.

## Save the design

Save the design in a `.world/` directory at the workspace root. Hidden directories stay out of OhMyGame publish archives, so the design never ships with the world.

- `.world/request.md`: the user's original request, verbatim, with later revision requests appended.
- `.world/expanded-prompt.md`: the self-contained design and the source of truth for the scene. Open with a short note separating what came from the user and what you inferred. If implementation forces a substantive design change, record the change and the reason rather than silently dropping it.
- `.world/scene-summary.json`: a short index of the design.

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
