# Implicit SDF Modeling

This is WS1. It gives the generator a code-side implicit surface path for shapes
that need one welded organic body instead of a stack of separate primitives.

Use it when the reference calls for smooth unions, blended limbs, soft transitions,
or another form that breaks down if you keep stacking boxes and capsules.

## What the spec carries

The spec uses `component.topologyClass: "implicit"` together with
`geometryDescriptor.sdf`.

The descriptor is limited to these primitive types:

```json
{
  "primitives": [
    { "id": "torso", "type": "capsule", "radius": 0.28, "height": 1.1 },
    { "id": "head", "type": "sphere", "radius": 0.34 }
  ],
  "operations": [
    { "type": "smooth-union", "left": "torso", "right": "head", "radius": 0.12, "id": "body" }
  ],
  "resolution": 32,
  "bounds": { "min": [-1.2, -1.6, -1.2], "max": [1.2, 1.6, 1.2] }
}
```

Supported primitives are `sphere`, `capsule`, `box`, `cone`, and `ellipsoid`.
Supported operations are `smooth-union`, `subtract`, and `intersect`.

## Limits

- `primitives` must be non-empty and stay at or below 64 entries.
- `operations` is optional, but when present it stays at or below 128 entries.
- `resolution` must stay between 4 and 64.
- Optional bounds, when present, must have ordered `min` and `max` vectors.

## Generator behavior

The generator samples the SDF, polygonizes it, and recomputes normals on the
resulting geometry. The output is still procedural code, not an imported mesh.

The emitted geometry keeps the default pipeline unchanged when no SDF block is
present. Subdivision is not available on the emitted `implicit sdf` path.

## Validation rules

- `geometryDescriptor.sdf` must be structurally valid before codegen.
- `sdf` and `visualHull` cannot live on the same component.
- `sdf` and `subdivide` cannot be combined for the implicit path.
- Primitive and operation ids must stay unique.

## Acceptance criteria

- A torso plus limb fixture emits one welded geometry with continuous normals.
- Default object-only specs stay byte-identical.
- Forge unit tests pass and the showcase TypeScript smoke stays clean.
