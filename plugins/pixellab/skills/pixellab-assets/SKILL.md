---
name: pixellab-assets
description: Create PixelLab pixel art, reusable directional characters, and character animations in the Asset Canvas. Use when a game asset needs PixelLab generation; do not use for general image generation with another provider.
---

# PixelLab Assets

Use PixelLab through the normal **Image** node's PixelLab model selection. Check that the PixelLab provider is enabled and configured before creating work that depends on it.

## Choose a model

- **Pixen pixel art**: use for a new, single pixel-art image from a description. It does not take a reference image.
- **Create character**: use for a reusable character with PixelLab's directional views. A single south-facing character reference is optional; otherwise describe the character.
- **Skeleton animation**: use for an animated character GIF. It requires exactly one character reference image. Put the requested motion in the prompt, such as `walk in place`, `sword slash`, or `fall backward`.

Keep prompts focused on the asset, pose or action. Do not claim that the app has locally generated frames, pose data, or a sprite sheet: show PixelLab's returned image or GIF as-is.

## Reference artwork

Use a single, complete character on a transparent background when practical. Character references are reduced to PixelLab's 256×256 limit before the request, without altering the image shown on the canvas.
