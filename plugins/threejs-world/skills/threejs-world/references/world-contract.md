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

Keep the design and the visible result aligned. A generic box, cylinder, or smooth tube carrying a subject's name does not realize its appearance. Placeholder geometry, default materials, object names, and debug panels do not count as visual finish. Temporary substitutes can support construction; any that remain are incomplete requirements to disclose.

## Presentation and review views

Implement [the presentation guide](presentation.md) using the design's identity, hierarchy, copy, and responsive layout.

Provide a world overview, main-route views, hero close-ups, and views of meaningful environmental details. Each navigation item must reach its advertised camera view or route, and the entry action must activate its designed behavior. Keep the selected view and current-location text accurate. A camera jump does not prove a route is reachable; check the actual route with appropriate grounding, scale, and occlusion.

## Interaction and performance

Define navigable bounds and handle obstructions on the requested routes. Do not trap the camera or start it inside geometry. Orbit, walking, and scenic viewpoints can coexist when they support exploration.

Observe and measure the rendered project before optimizing or reducing detail. Use that evidence to choose geometry and material reuse, instancing, batching, culling, distance-dependent detail, or fewer per-frame allocations while preserving the design and near-view quality. Do not set a low-detail target in advance as an assumed performance requirement. Keep post-processing optional and measurable.

## Handoff

Keep the design files in `.world/` and the runnable world in the workspace. In the final reply, give the controls, the major source locations, asset credits, known limitations, and the review evidence. A screenshot supplements the runnable world; it does not replace it.
