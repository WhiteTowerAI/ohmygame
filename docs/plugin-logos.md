# Plugin logos

Product integrations use recognizable brand artwork in their own `assets/`
directory. Each manifest points to that file with `interface.icon.type: asset`.
Bundled workflow plugins can use their own artwork through the same contract.
Generic capabilities continue to use Solar presets. The renderer does not map
engine names to special logo components.

## Resources and provenance

Blender, Godot, TapTap Maker, Cocos Creator, WeChat Mini Games, Douyin Mini Games,
Unity, Unreal Engine, Aseprite, and Tiled include local logos. Each package keeps
the source, upstream terms, and any preparation in
`assets/NOTICE.md`. These notices travel with exported and imported packages.
TapTap Maker currently uses the official TapTap app mark to identify the service.

Game Studio, Web Game Studio, and Image to Three.js use user-selected
Streamline Ultimate color (CC BY 4.0) artwork: **Module Puzzle**, **Card Game Heart**,
and **Vectors Anchor Rectangle**, respectively. Original geometry, colors, and
attribution are retained. Three.js World uses
the upstream Three.js mark and retains its MIT license.

Image to Three.js is a preinstalled third-party package from `img2threejs/img2threejs`,
locked in `config/preinstalled-plugins.json`. Its build-only `assets` directory
(`config/plugin-assets/img2threejs`) is copied into the prepared package's `assets/`.
These files participate in the preparation fingerprint and final archive checksum.
Change the prepared release ID and checksum when shipping updated assets so existing
installations receive them through the normal preinstalled-package update path.
The icon and notice then travel with the package, just like bundled plugin assets.

Prefer an official resource. When using a curated collection such as Simple
Icons, record that collection and its terms as the source. Keep original colors
and shape geometry. Pixel artwork and raster-only resources remain PNG; do not
trace them or wrap their base64 in SVG. SVG files exported by editors may need
metadata removed and inline styles converted to equivalent presentation
attributes before they meet the [static icon contract](plugins.md#plugin-icons).

## Display and maintenance

Plugin cards, details, Builder previews, and conversation references share
`PluginGlyph` / `PluginIcon`. Local assets are fetched through authenticated
image routes and rendered as images. Artwork must remain readable in both themes.
The Unity, Unreal, and Three.js World assets include a light backplate for contrast,
so their appearance survives export without theme variants or global background
changes to user images. Failed images retain the standard fallback.

To update a logo, replace the package asset and update its notice.
Keep the manifest path when practical. Content revisions refresh icon loading
and HTTP ETags. Check the card, detail, and small reference sizes in both themes,
plus an installed-package/archive round trip when changing the icon contract.
Do not add an application-wide engine-name registry or fetch logos at runtime.
