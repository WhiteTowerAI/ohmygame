# Plugin logos

Product integrations use recognizable brand artwork in their own `assets/`
directory. Each manifest points to that file with `interface.icon.type: asset`.
Generic capabilities continue to use Solar presets. The renderer does not map
engine names to special logo components.

## Resources and provenance

Blender, Godot, TapTap Maker, Cocos Creator, WeChat Mini Games, Douyin Mini Games,
Unity, Unreal Engine, Aseprite, and Tiled include local logos. Each package keeps
the source, upstream terms, and any preparation in
`assets/NOTICE.md`. These notices travel with exported and imported packages.
TapTap Maker currently uses the official TapTap app mark to identify the service.

Prefer an official resource. When using a curated collection such as Simple
Icons, record that collection and its terms as the source. Keep original colors
and shape geometry. Pixel artwork and raster-only resources remain PNG; do not
trace them or wrap their base64 in SVG. SVG files exported by editors may need
metadata removed and inline styles converted to equivalent presentation
attributes before they meet the [static icon contract](plugins.md#plugin-icons).

## Display and maintenance

Plugin cards, details, Builder previews, and conversation references share
`PluginGlyph` / `PluginIcon`. Local assets are fetched through authenticated
image routes and rendered as images. Artwork must remain readable in both themes. The Unity and Unreal assets include
a light backplate for contrast, so their appearance survives export without theme
variants or global background changes to user images. Failed images retain the
standard fallback.

To update a logo, replace the package asset and update its notice.
Keep the manifest path when practical. Content revisions refresh icon loading
and HTTP ETags. Check the card, detail, and small reference sizes in both themes,
plus an installed-package/archive round trip when changing the icon contract.
Do not add an application-wide engine-name registry or fetch logos at runtime.
