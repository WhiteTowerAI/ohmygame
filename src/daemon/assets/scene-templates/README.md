# Last Bus template artwork

Source: the user-supplied Last Bus (`末班`) project archive, `末班 (项目).zip`.

These stills are resized to 1280 × 720 WebP at quality 80; the source project
is not needed at runtime.

| File                | Original project file           | Templates    |
| ------------------- | ------------------------------- | ------------ |
| `cover.webp`        | `assets/library/1_01.jpg`       | Blank        |
| `menu.webp`         | `assets/library/output-4.png`   | Main menu    |
| `phone.webp`        | `assets/library/10-16.png`      | Choice       |
| `bell.webp`         | `assets/library/点击.png`       | QTE          |
| `cabin.webp`        | `assets/imported/output-24.png` | Hotspot      |
| `ending.webp`       | `assets/library/output-7.png`   | Ending       |
| `station.webp`      | `assets/imported/output-22.png` | Visual Novel |
| `store-window.webp` | `assets/imported/output-13.png` | Story map    |

`playable-template-artwork.ts` declares a small CSS file that references
`./lastbus/<picture>.webp`. The illustration is copied as a separate binary
file to `shared/templates/lastbus/` only when first used by a project; existing
CSS and images are never overwritten. No image is read when the preset
catalog is loaded. The host build copies these files to
`dist/daemon/assets/scene-templates/`; desktop packaging includes the WebPs.
Template picker pictures in `src/renderer/assets/templates/` are captures of
the corresponding rendered Scenes, including their controls and text.

Each illustration stylesheet is scoped to the Scene's `data-template-artwork`
attribute, including its letterbox setting. It does not restyle other Scenes.
The Visual Novel intentionally omits the opening `@show stranger center`:
the station illustration already contains characters, and the placeholder
silhouette would cover them. Its original generic rain/stranger dialogue
remains a script example rather than an adaptation of the Last Bus story.
