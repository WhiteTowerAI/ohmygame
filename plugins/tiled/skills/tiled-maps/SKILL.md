---
name: tiled-maps
description: Create or edit Tiled TMX/TMJ maps and TSX/TSJ tilesets, including collision and gameplay object layers, and export them for the consuming game engine.
---

# Tiled Maps

Inspect the consuming engine's map importer before choosing a map format, orientation, finite/infinite mode, compression, tile size, and object-property schema. Preserve existing layer/object IDs, custom classes, tileset references, image paths, and animation data. Use a local Tiled executable for editor and CLI checks; read `--version` and `--help` for the installed version.

TMX/TMJ maps and TSX/TSJ tilesets may be edited with file tools when their schema is understood. Keep shared tilesets external when the project already does so, with paths relative to the owning file. Retain the editable source when a runtime export is generated. Avoid adding an importer dependency merely because a map can be authored in Tiled: confirm native support or propose the smallest integration the requested game needs.

## Export and integrate

The standard JSON export entrypoint is:

```text
<TILED> --export-map json <SOURCE.tmx> <OUTPUT.json>
```

Use a different output path from the source. Inspect existing output before replacement, retain external tilesets/images in the delivered layout, and resolve paths relative to each referencing file. A successful map export does not guarantee every external tileset was converted to the format required by a particular loader.

Tile GIDs are not tileset-local indices: resolve `firstgid` and the transformation flags before indexing tiles, including the orientation-specific rotation flag. Empty tiles use GID 0. Infinite maps store chunks instead of a single flat layer array. Object positions, rotation, shapes, tile-object alignment, and tile-collision shapes require the consuming engine's conventions; do not flatten them to rectangles silently.

Use named object layers and typed properties for spawn points, goals, triggers, and collision according to the game's actual importer. Keep decorative tiles and gameplay collision distinguishable. If that engine cannot consume a feature, use a supported representation and disclose the conversion.

## Verification

Open the source in Tiled, check missing images/tilesets, and inspect the exported map's dimensions, layers, properties, and paths. Load it through the target engine and verify tile placement, flip/rotation, collision, player spawn, and the affected goal/trigger behavior. Reopen after save/export to check persistence. In Asset Canvas, deliver source maps, required tilesets/images, and exports and identify the remaining runtime check.

Official references: [export formats and CLI](https://doc.mapeditor.org/en/stable/manual/export/), [JSON format](https://doc.mapeditor.org/en/stable/reference/json-map-format/), [global tile IDs](https://doc.mapeditor.org/en/stable/reference/global-tile-ids/).
