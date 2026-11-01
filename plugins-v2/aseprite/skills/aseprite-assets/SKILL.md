---
name: aseprite-assets
description: Create or edit Aseprite pixel art and export PNG sprite sheets with JSON frame, tag, and timing metadata for a game engine.
---

# Aseprite Assets

Use the installed CLI; on macOS it is inside the app bundle, commonly `/Applications/Aseprite.app/Contents/MacOS/aseprite`. Check `--version` and `--help` before relying on version-specific options.

Keep the editable `.aseprite` or `.ase` source separate from runtime exports and never save over it while exporting. For repeatable edits to layers, frames, tags, or palettes, run a Lua script with `--batch --script <FILE>`. Preserve existing layers, tags, slices, and frame durations outside the requested change.

## Export

Match the engine's loader first: packed atlases need per-frame rectangles, while fixed-grid loaders need uniform cells (`--sheet-type rows`, no `--trim`). A packed export with full metadata:

```text
<ASEPRITE> --batch <SOURCE.aseprite> --sheet-type packed --sheet <OUT.png> --data <OUT.json> --format json-array --list-tags --list-slices
```

The CLI overwrites the `--sheet` and `--data` targets without asking.

## Verify

Parse the JSON and check that every frame rectangle lies inside the sheet and every tag references existing frames. Load the sheet through the engine's real loader and check frame timing, transparency, pivots, and tag playback in the running game.
