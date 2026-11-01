---
name: web-3d-asset-pipeline
description: Create, prepare, optimize, and integrate browser-game GLB or glTF assets, including transforms, materials, textures, collision, LOD, and runtime validation.
---

# Web 3D Asset Pipeline

Use this skill for shipped 3D assets rather than scene, camera, or gameplay architecture. Preserve established scale, axes, naming, pivots, and material conventions.

## Pipeline

1. Define the asset's gameplay purpose, visible size, interactions, animation needs, collision role, and target budget.
2. Create or acquire the source using the user's requested workflow. Use `generate_canvas_media` for saved canvas nodes, `generate_3d_asset` for standalone assets, or a matching installed reconstruction skill when appropriate.
3. Normalize transforms, units, axes, pivots, hierarchy names, and material assignments.
4. Ship GLB or glTF 2.0 unless the existing engine has a different established runtime contract.
5. Remove unused nodes, duplicate materials, excess geometry, and oversized textures.
6. Add collision proxies, LODs, animation clips, or baked-lighting data only when the runtime needs them.
7. Integrate through stable asset keys and validate the actual runtime load.

## Optimization

- Prefer material and texture reuse over unique resources per mesh.
- Choose geometry compression based on runtime support and decode cost.
- Use KTX2 or BasisU when the loader and asset pipeline already support them.
- Size textures for on-screen use rather than source-art resolution.
- Keep collision meshes simpler than visible geometry.
- Measure before adding LODs or aggressive compression to small assets.

## Validation

Check load errors, scale, orientation, pivot behavior, material appearance, animation names, collision alignment, memory or download cost, and disposal. Do not claim visual parity from file metadata alone.

Use `../three-webgl-game/SKILL.md` or `../react-three-fiber-game/SKILL.md` for runtime scene integration and `../game-playtest/SKILL.md` for player-facing verification.
