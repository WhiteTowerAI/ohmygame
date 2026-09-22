---
name: sprite-pipeline
description: Create, integrate, and normalize consistent 2D game sprites, animation strips, frame anchors, atlases, and in-game previews.
---

# Sprite Pipeline

Use this skill for production 2D sprites and frame-based animation, not for generic illustrations. Preserve approved character identity, palette, scale, and anchor conventions already present in the game.

## Workflow

1. Inspect the runtime's frame size, facing convention, anchor, palette, manifest, and animation definitions.
2. Start from an approved in-game frame when one exists. Do not regenerate unrelated sprite sets for a focused change.
3. Define action, direction, frame count, slot layout, timing, loop behavior, and transparency before generation.
4. Generate or edit the whole strip together when possible; independent frame generation causes identity and scale drift.
5. Normalize every frame to one canvas size, shared scale, and shared anchor, usually bottom-center.
6. Update the asset manifest and animation metadata through stable keys.
7. Inspect a preview and the animation at actual game scale before approval.

Use OhMyGame's `generate_image` tool for new source art when it fits the request. If the available generator cannot preserve an approved reference or transparency reliably, state the limitation and use the project's existing asset workflow rather than pretending consistency was verified.

## Generation Invariants

- same character identity, silhouette, outfit proportions, and palette family
- consistent facing and camera angle
- transparent background with no scenery, labels, or poster composition
- exact frame count and grid layout
- readable action silhouettes at gameplay scale
- stable feet or contact point across frames

## Quality Gates

- no frame-to-frame scale or anchor drift
- no clipped effects or unintended opaque background
- idle and transition frames connect without a visible jump
- timing matches the gameplay event
- manifest, preload, and runtime animation names agree

Use `../phaser-2d-game/SKILL.md` for runtime integration and `../game-playtest/SKILL.md` for in-game verification.
