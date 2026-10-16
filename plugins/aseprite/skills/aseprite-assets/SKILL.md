---
name: aseprite-assets
description: Create or edit pixel art in Aseprite, retain editable sources, and export PNG sprite sheets with JSON frame, timing, and animation-tag metadata for a game.
---

# Aseprite Assets

Locate the installed Aseprite executable, using an absolute path when it is not on PATH; macOS applications commonly keep it inside the app bundle. Read `--version` and `--help` before using version-specific CLI or Lua features. This workflow needs a local installation and does not supply an MCP bridge.

Inspect the target engine's sprite loader and existing asset conventions before choosing frame sizes, anchors, palette, tags, and sheet layout. Preserve editable `.aseprite` or `.ase` source separately from runtime exports. Use Aseprite's Lua API for repeatable document/layer/frame edits when appropriate; retain existing layers, tags, slices, and timing outside the requested change.

## Export and integrate

Use the official batch CLI for export, with quoted absolute paths. A typical metadata-preserving export is:

```text
<ASEPRITE> --batch <SOURCE.aseprite> --sheet-type packed --sheet <OUTPUT.png> --data <OUTPUT.json> --format json-array --list-tags --list-slices
```

Match the consuming loader: packed/trimmed frames need atlas metadata, while fixed-grid loaders need a consistent cell layout. Keep frame durations, tag direction/ranges, trim offsets, and slice/pivot information when used. CLI exports overwrite destination files; inspect existing outputs and use a separate test destination when replacements are outside the requested change. Do not save over the editable source as a side effect of exporting it.

Open the exported sheet, parse the JSON, and check that every frame rectangle lies within the image and that required tags reference valid frames. Integrate both the image and metadata through the engine's actual loader. Confirm animation speed, transparency, anchors, and tag selection in the running game; a PNG alone cannot prove animation correctness. In Asset Canvas, deliver the source and exports and name the target-engine check still needed.

Official references: [CLI](https://www.aseprite.org/docs/cli/), [Lua API](https://www.aseprite.org/api/).
