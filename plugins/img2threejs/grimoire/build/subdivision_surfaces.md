# Subdivision Surfaces

This is WS3. It adds an opt-in Catmull-Clark refinement pass so a coarse cage can
become a smooth dense surface without leaving the code pipeline.

Use it when the control cage is right but the surface still needs a cleaner read or
more even density.

## Spec shape

The spec uses `geometryDescriptor.subdivide.iterations`.

```json
{
  "geometryDescriptor": {
    "subdivide": { "iterations": 2 }
  }
}
```

`iterations` is optional. When it is missing, the generator does not emit the helper.

## Limits

- `iterations` must be an integer from 0 to 4.
- The projected quad face count must stay at or below 100000.
- Primitive paths that cannot be budgeted safely, such as open planes or implicit SDF output, are rejected.

## Generator behavior

The generator emits `subdivideCatmullClark`, applies the requested iteration count,
and recomputes normals after each subdivision pass.

The helper is deterministic. The same input spec produces the same output source.

## Validation rules

- `subdivide` cannot rescue a topology that is already invalid.
- Non-manifold edges, open boundary edges, and disconnected face fans are rejected.
- `implicit sdf` output does not use this path.

## Acceptance criteria

- A valid cage gains the expected quad growth per iteration.
- UV2 data stays in step with the subdivided surface.
- The showcase TypeScript smoke stays clean after generation.
