# Visual Hull Reconstruction

This is WS2. It reconstructs geometry from clean silhouette views, then treats the
hidden areas as low confidence instead of inventing detail.

Use it when you have at least two clean orthographic-ish masks and the silhouette is
the main thing that is holding back the model.

## What the spec carries

The spec uses `geometryDescriptor.visualHull` with these fields:

```json
{
  "projection": "orthographic",
  "boundsSpace": "component-local",
  "bounds": { "min": [-1, -1, -1], "max": [1, 1, 1] },
  "resolution": 32,
  "triangleBudget": 400000,
  "views": [
    { "axis": "front", "confidence": 0.9, "mask": ["11110000"] },
    { "axis": "side", "confidence": 0.8, "mask": ["11100000"] }
  ],
  "hiddenRegions": ["back", "underside"]
}
```

The `views` array needs distinct axes. Valid axes are `front`, `side`, and `top`.
Each mask is a binary string grid.

## Limits

- At least two views are required.
- `resolution` must stay between 4 and 32.
- `triangleBudget` must be positive and stay at or below 400000.
- The budget must also cover the worst-case triangle count implied by the chosen resolution.
- Masks must stay within the supported size window and contain foreground pixels.

## Generator behavior

The generator carves the volume from silhouettes, welds the result, and stores the
visual-hull metadata on the runtime geometry. The emitted source keeps the hidden
regions visible in the metadata so the review loop can mark them low confidence.

This path does not combine with `sdf` or `subdivide` on the same component.

## Validation rules

- `projection` must be `orthographic`.
- `boundsSpace` must be `component-local`.
- Repeated axes are rejected.
- Contradictory masks fail at runtime with a typed occupancy error.

## Acceptance criteria

- Two clean silhouettes produce a welded mesh whose silhouette matches each view.
- Hidden regions stay marked low confidence.
- The turnaround path improves the reference baseline instead of flattening into noise.
