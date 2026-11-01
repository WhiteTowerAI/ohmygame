---
name: tiled-maps
description: Create or edit Tiled TMX/TMJ maps and TSX/TSJ tilesets, including collision and gameplay object layers, and export them for the game engine.
---

# Tiled Maps

Start from the engine's map loader. It decides the format, orientation, finite or infinite mode, compression, tile size, and object property schema. If the engine cannot read Tiled maps, propose the smallest importer the game needs instead of adding a dependency by default.

## Edit

TMX/TMJ and TSX/TSJ files can be edited directly. Preserve layer and object IDs, custom classes and properties, tile animations, and tileset and image paths (relative to the referencing file). Keep tilesets external when the project does. Mark spawn points, goals, triggers, and collision with named object layers and typed properties, separate from decorative tiles.

Tile GIDs are global: mask off the flip and rotation flags in the high bits, then find the tileset by `firstgid`. GID 0 is empty, and infinite maps store layers as chunks.

## Export

```text
<TILED> --export-map json <SOURCE.tmx> <OUTPUT.json>
```

Write to a different path than the source. External tilesets stay as references unless you add `--embed-tilesets`. For loaders without template or custom-type support, use `--detach-templates` and `--resolve-types-and-properties`. Check `--help` for the installed version's options.

## Verify

Load the map through the engine and check tile placement and flips, collision, spawn, and any changed goals or triggers. When the engine lacks a feature such as polygon collision or rotated objects, convert it explicitly and tell the user.
